// Admin endpoints for schema management and data import

module.exports = function(app, getPool, initializeDatabase) {
  console.log('🔧 Adding admin endpoints for schema and data...');

  // Health check endpoint
  app.get('/admin/test', (req, res) => {
    res.json({ message: 'Admin routes working!', timestamp: new Date().toISOString() });
  });

  // Schema update endpoint for artists and songs
  app.post('/admin/update-schema', async (req, res) => {
    try {
      console.log('🏗️ Admin: Updating schema for artists and songs...');

      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      await pool.query('BEGIN');

      // 1. Artists table (enhanced with claiming support)
      console.log('📋 Creating/updating artists table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS artists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          bio TEXT,
          location VARCHAR(255),
          genres TEXT[] DEFAULT '{}',

          -- Social media URLs
          facebook_url TEXT,
          instagram_url TEXT,
          website_url TEXT,
          spotify_url TEXT,
          apple_music_url TEXT,
          youtube_url TEXT,
          soundcloud_url TEXT,
          social_media_urls JSONB DEFAULT '[]',

          -- Images
          profile_image_url TEXT,
          banner_image_url TEXT,

          -- Platform management
          claimed_by_user_id UUID, -- Links to bndy-backstage user who claimed this profile
          is_verified BOOLEAN DEFAULT false,

          -- Public metrics (bndy-live display)
          follower_count INTEGER DEFAULT 0,
          monthly_listeners INTEGER DEFAULT 0,

          -- bndy-backstage management fields (only used when claimed)
          management_email TEXT,
          management_phone TEXT,
          booking_info TEXT,
          tech_rider_url TEXT,

          -- Data provenance
          migrated_from_id VARCHAR(255) UNIQUE,
          source_platform VARCHAR(50) DEFAULT 'community-builder', -- 'community-builder', 'self-signup', 'firestore-migration'
          created_by_platform VARCHAR(50) DEFAULT 'bndy-live', -- 'bndy-live', 'bndy-backstage'

          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Create indexes for artists
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_name ON artists (name);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_genres ON artists USING GIN (genres);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_location ON artists (location);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_migrated_id ON artists (migrated_from_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_claimed_by ON artists (claimed_by_user_id);');

      // 2. Update venues table to support claiming (if not already present)
      console.log('🏢 Updating venues table to support claiming...');
      await pool.query(`
        ALTER TABLE venues
        ADD COLUMN IF NOT EXISTS claimed_by_user_id UUID,
        ADD COLUMN IF NOT EXISTS management_email TEXT,
        ADD COLUMN IF NOT EXISTS management_phone TEXT,
        ADD COLUMN IF NOT EXISTS booking_info TEXT,
        ADD COLUMN IF NOT EXISTS created_by_platform VARCHAR(50) DEFAULT 'bndy-live';
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_venues_claimed_by ON venues (claimed_by_user_id);');

      // 3. Songs table
      console.log('🎵 Creating songs table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS songs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title VARCHAR(255) NOT NULL,
          artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
          artist_name VARCHAR(255) NOT NULL, -- Denormalized for performance
          duration_seconds INTEGER,
          genre VARCHAR(100),
          release_date DATE,
          album VARCHAR(255),
          track_number INTEGER,
          explicit_content BOOLEAN DEFAULT false,

          -- Streaming URLs
          spotify_url TEXT,
          apple_music_url TEXT,
          youtube_url TEXT,
          soundcloud_url TEXT,
          bandcamp_url TEXT,

          -- File storage (for uploaded tracks)
          audio_file_url TEXT,
          audio_file_size INTEGER,
          audio_format VARCHAR(10), -- mp3, wav, etc

          -- Metadata
          bpm INTEGER,
          key_signature VARCHAR(10),
          lyrics TEXT,
          description TEXT,
          tags TEXT[] DEFAULT '{}',

          -- Admin fields
          is_featured BOOLEAN DEFAULT false,
          play_count INTEGER DEFAULT 0,
          like_count INTEGER DEFAULT 0,
          migrated_from_id VARCHAR(255) UNIQUE,
          source_platform VARCHAR(50) DEFAULT 'bndy-centrestage',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Create indexes for songs
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs (artist_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_title ON songs (title);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs (genre);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_release_date ON songs (release_date);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_featured ON songs (is_featured);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_migrated_id ON songs (migrated_from_id);');

      // 4. Artist-Song many-to-many for collaborations
      console.log('🤝 Creating artist_songs collaboration table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS artist_songs (
          artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
          song_id UUID REFERENCES songs(id) ON DELETE CASCADE,
          role VARCHAR(50) DEFAULT 'performer', -- performer, writer, producer, etc
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (artist_id, song_id, role)
        );
      `);

      await pool.query('COMMIT');

      // Verify tables were created
      const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('artists', 'songs', 'artist_songs', 'venues', 'events')
        ORDER BY table_name;
      `);

      // Check current data counts
      const counts = await Promise.all([
        pool.query('SELECT COUNT(*) FROM venues'),
        pool.query('SELECT COUNT(*) FROM artists'),
        pool.query('SELECT COUNT(*) FROM songs'),
        pool.query('SELECT COUNT(*) FROM events')
      ]);

      res.json({
        success: true,
        message: 'Schema updated successfully',
        tables: tablesResult.rows.map(row => row.table_name),
        counts: {
          venues: parseInt(counts[0].rows[0].count),
          artists: parseInt(counts[1].rows[0].count),
          songs: parseInt(counts[2].rows[0].count),
          events: parseInt(counts[3].rows[0].count)
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      const pool = getPool();
      if (pool) await pool.query('ROLLBACK');
      console.error('❌ Schema update failed:', error);
      res.status(500).json({ error: 'Schema update failed', details: error.message });
    }
  });

  // Import artists endpoint
  app.post('/admin/import-artists', async (req, res) => {
    try {
      console.log('🎤 Admin: Importing artists...');

      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const { artists } = req.body;

      if (!artists || !Array.isArray(artists)) {
        return res.status(400).json({ error: 'Invalid artists data - expected array' });
      }

      let imported = 0;
      let skipped = 0;

      for (const artist of artists) {
        try {
          // Skip bands (sourceType === 'band') as requested
          if (artist.sourceType === 'band') {
            skipped++;
            continue;
          }

          // Transform social media URLs
          const socialUrls = artist.socialMediaURLs || [];
          const facebookUrl = socialUrls.find(s => s.platform === 'facebook')?.url || '';
          const instagramUrl = socialUrls.find(s => s.platform === 'instagram')?.url || '';
          const websiteUrl = socialUrls.find(s => s.platform === 'website')?.url || '';

          const query = `
            INSERT INTO artists (
              name, bio, location, genres, facebook_url, instagram_url, website_url,
              social_media_urls, profile_image_url, migrated_from_id, source_platform, created_by_platform
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (migrated_from_id) DO UPDATE SET
              name = EXCLUDED.name,
              bio = EXCLUDED.bio,
              updated_at = NOW()
          `;

          await pool.query(query, [
            artist.name || '',
            artist.bio || '',
            artist.location || '',
            artist.genres || [],
            facebookUrl,
            instagramUrl,
            websiteUrl,
            JSON.stringify(socialUrls),
            artist.profileImageUrl || '',
            artist.id, // Original Firestore ID
            'firestore-migration',
            'bndy-live'
          ]);

          imported++;
        } catch (artistError) {
          console.warn(`⚠️ Skipping artist ${artist.name}: ${artistError.message}`);
          skipped++;
        }
      }

      res.json({
        success: true,
        imported,
        skipped,
        total: artists.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Artist import failed:', error);
      res.status(500).json({ error: 'Artist import failed', details: error.message });
    }
  });

  // Import songs endpoint
  app.post('/admin/import-songs', async (req, res) => {
    try {
      console.log('🎵 Admin: Importing songs...');

      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const { songs } = req.body;

      if (!songs || !Array.isArray(songs)) {
        return res.status(400).json({ error: 'Invalid songs data - expected array' });
      }

      let imported = 0;
      let skipped = 0;

      for (const song of songs) {
        try {
          // For now, import songs without artist linkage (since artist names may not match exactly)
          // Future enhancement: implement artist name matching/lookup

          const streamingUrls = song.streamingUrls || {};

          const query = `
            INSERT INTO songs (
              title, artist_name, duration_seconds, genre, release_date,
              spotify_url, apple_music_url, youtube_url, soundcloud_url, bandcamp_url,
              audio_file_url, audio_format, bpm, key_signature, lyrics, description, tags,
              is_featured, migrated_from_id, source_platform
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            ON CONFLICT (migrated_from_id) DO UPDATE SET
              title = EXCLUDED.title,
              updated_at = NOW()
          `;

          await pool.query(query, [
            song.title || '',
            song.artistName || '',
            song.duration || null,
            song.genre || '',
            song.releaseDate || null,
            streamingUrls.spotify || '',
            streamingUrls.appleMusic || '',
            streamingUrls.youtube || '',
            streamingUrls.soundcloud || '',
            streamingUrls.bandcamp || '',
            song.audioFileUrl || '',
            song.audioFormat || '',
            song.bpm || null,
            song.keySignature || '',
            song.lyrics || '',
            song.description || '',
            song.tags || [],
            song.isFeatured || false,
            song.id, // Original Firestore ID
            'firestore-migration'
          ]);

          imported++;
        } catch (songError) {
          console.warn(`⚠️ Skipping song ${song.title}: ${songError.message}`);
          skipped++;
        }
      }

      res.json({
        success: true,
        imported,
        skipped,
        total: songs.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Song import failed:', error);
      res.status(500).json({ error: 'Song import failed', details: error.message });
    }
  });

  // Get artists endpoint
  app.get('/api/artists', async (req, res) => {
    try {
      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const result = await pool.query(`
        SELECT
          id, name, bio, location, genres,
          facebook_url as "facebookUrl",
          instagram_url as "instagramUrl",
          website_url as "websiteUrl",
          social_media_urls as "socialMediaUrls",
          profile_image_url as "profileImageUrl",
          is_verified as "isVerified",
          follower_count as "followerCount",
          claimed_by_user_id as "claimedByUserId",
          created_at as "createdAt"
        FROM artists
        ORDER BY name
      `);

      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching artists:', error);
      res.status(500).json({ error: 'Failed to fetch artists' });
    }
  });

  // Get songs endpoint
  app.get('/api/songs', async (req, res) => {
    try {
      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const result = await pool.query(`
        SELECT
          id, title, artist_name as "artistName", duration_seconds as "duration",
          genre, release_date as "releaseDate", album,
          spotify_url as "spotifyUrl",
          apple_music_url as "appleMusicUrl",
          youtube_url as "youtubeUrl",
          audio_file_url as "audioFileUrl",
          is_featured as "isFeatured",
          tags, created_at as "createdAt"
        FROM songs
        ORDER BY title
      `);

      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching songs:', error);
      res.status(500).json({ error: 'Failed to fetch songs' });
    }
  });
};
