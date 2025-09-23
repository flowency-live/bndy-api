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

      // 5. Users table (bndy-backstage user profiles)
      console.log('👤 Creating users table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          supabase_id TEXT UNIQUE,
          phone TEXT UNIQUE,
          email TEXT UNIQUE,

          -- Profile fields - mandatory after authentication
          first_name TEXT,
          last_name TEXT,
          display_name TEXT,
          hometown TEXT, -- UK Google Places autocomplete
          avatar_url TEXT,
          instrument TEXT, -- from predefined list

          -- System fields
          platform_admin BOOLEAN DEFAULT false, -- Platform administrator role
          profile_completed BOOLEAN DEFAULT false, -- Track if mandatory profile fields are set
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Create indexes for users
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_supabase_id ON users (supabase_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_display_name ON users (display_name);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_hometown ON users (hometown);');

      // 6. Enhance artists table for bndy-backstage claiming (add missing fields)
      console.log('🎨 Enhancing artists table for band claiming...');
      await pool.query(`
        ALTER TABLE artists
        ADD COLUMN IF NOT EXISTS claimed_by_user_id UUID,
        ADD COLUMN IF NOT EXISTS artist_type VARCHAR(50) DEFAULT 'band',
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS avatar_url TEXT,
        ADD COLUMN IF NOT EXISTS allowed_event_types TEXT[] DEFAULT '{"practice","public_gig"}',
        ADD COLUMN IF NOT EXISTS created_by UUID,
        ADD COLUMN IF NOT EXISTS slug TEXT
      `);

      // Add unique constraint for slug if it doesn't exist
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artists_slug_unique') THEN
            ALTER TABLE artists ADD CONSTRAINT artists_slug_unique UNIQUE (slug);
          END IF;
        END $$;
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_claimed_by ON artists (claimed_by_user_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_type ON artists (artist_type);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_artists_slug ON artists (slug);');

      // 7. bndy-backstage supporting tables
      console.log('👥 Creating bndy-backstage supporting tables...');

      // user_bands (band membership)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_bands (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          band_id UUID REFERENCES artists(id) ON DELETE CASCADE, -- References artists table (not separate bands)
          role TEXT NOT NULL DEFAULT 'member', -- 'owner', 'admin', 'member'
          display_name TEXT NOT NULL,
          icon TEXT NOT NULL,
          color TEXT NOT NULL,
          avatar_url TEXT, -- Optional member avatar URL
          joined_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, band_id)
        );
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_user_bands_user ON user_bands (user_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_user_bands_band ON user_bands (band_id);');

      // invitations
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invitations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          band_id UUID REFERENCES artists(id) ON DELETE CASCADE, -- References artists table
          inviter_membership_id UUID REFERENCES user_bands(id) ON DELETE CASCADE,
          contact_info TEXT NOT NULL, -- phone or email
          contact_type TEXT NOT NULL, -- 'phone' or 'email'
          role TEXT NOT NULL DEFAULT 'member',
          token TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMP NOT NULL,
          accepted_at TIMESTAMP,
          invitee_user_id UUID REFERENCES users(id),
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_invitations_band ON invitations (band_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations (token);');

      // 8. Events table (unified for bndy-live + bndy-backstage)
      console.log('📅 Creating unified events table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          band_id UUID REFERENCES artists(id), -- Links to artists table (unified bands/artists)
          owner_user_id UUID REFERENCES users(id), -- For personal events (XOR with band_id)
          type TEXT NOT NULL, -- 'practice', 'meeting', 'recording', 'private_booking', 'public_gig', 'festival', 'unavailable'
          title TEXT,
          date TEXT NOT NULL, -- YYYY-MM-DD format
          end_date TEXT, -- Optional, for date ranges
          start_time TEXT, -- HH:MM format (24h)
          end_time TEXT, -- HH:MM format (24h)
          location TEXT, -- For private events
          venue TEXT, -- For public events (text name)
          notes TEXT,
          is_public BOOLEAN DEFAULT false, -- TRUE for public gigs/festivals visible on bndy-live
          membership_id UUID REFERENCES user_bands(id), -- bndy-backstage context
          is_all_day BOOLEAN DEFAULT false,
          created_by_membership_id UUID REFERENCES user_bands(id),
          created_at TIMESTAMP DEFAULT NOW(),

          -- Performance fields for bndy-live map queries (denormalized from venue)
          latitude DECIMAL(10, 8), -- Copied from venues table
          longitude DECIMAL(11, 8), -- Copied from venues table
          venue_id UUID REFERENCES venues(id), -- Proper reference to venues

          -- XOR constraint: exactly one of band_id or owner_user_id must be non-null
          CONSTRAINT events_ownership_xor CHECK (
            (band_id IS NOT NULL AND owner_user_id IS NULL) OR
            (band_id IS NULL AND owner_user_id IS NOT NULL)
          )
        );
      `);

      // CRITICAL PERFORMANCE INDEXES for map-based queries
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_map_query ON events (latitude, longitude, date) WHERE is_public = true AND date >= CURRENT_DATE`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_venue_public ON events (venue_id, date) WHERE is_public = true AND date >= CURRENT_DATE`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_band_date ON events (band_id, date);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_user_date ON events (owner_user_id, date);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_public ON events (is_public, date);');

      // 9. Song readiness tracking (bndy-backstage)
      console.log('🎵 Creating song management tables...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS song_readiness (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          song_id UUID REFERENCES songs(id) ON DELETE CASCADE,
          membership_id UUID REFERENCES user_bands(id) ON DELETE CASCADE, -- Band member readiness
          status TEXT NOT NULL, -- 'red', 'amber', 'green'
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(song_id, membership_id)
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS song_vetos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          song_id UUID REFERENCES songs(id) ON DELETE CASCADE,
          membership_id UUID REFERENCES user_bands(id) ON DELETE CASCADE, -- Band member veto
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(song_id, membership_id)
        );
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_song_readiness_song ON song_readiness (song_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_song_readiness_member ON song_readiness (membership_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_song_vetos_song ON song_vetos (song_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_song_vetos_member ON song_vetos (membership_id);');

      await pool.query('COMMIT');

      // Verify tables were created
      const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN (
          'artists', 'songs', 'artist_songs', 'venues', 'users',
          'user_bands', 'invitations', 'events', 'song_readiness', 'song_vetos'
        )
        ORDER BY table_name;
      `);

      // Check current data counts (handle tables that may not exist)
      const getCounts = async () => {
        const results = {};
        try { results.venues = (await pool.query('SELECT COUNT(*) FROM venues')).rows[0].count; } catch { results.venues = 0; }
        try { results.artists = (await pool.query('SELECT COUNT(*) FROM artists')).rows[0].count; } catch { results.artists = 0; }
        try { results.songs = (await pool.query('SELECT COUNT(*) FROM songs')).rows[0].count; } catch { results.songs = 0; }
        try { results.users = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count; } catch { results.users = 0; }
        try { results.events = (await pool.query('SELECT COUNT(*) FROM events')).rows[0].count; } catch { results.events = 0; }
        try { results.user_bands = (await pool.query('SELECT COUNT(*) FROM user_bands')).rows[0].count; } catch { results.user_bands = 0; }
        try { results.invitations = (await pool.query('SELECT COUNT(*) FROM invitations')).rows[0].count; } catch { results.invitations = 0; }
        try { results.song_readiness = (await pool.query('SELECT COUNT(*) FROM song_readiness')).rows[0].count; } catch { results.song_readiness = 0; }
        return results;
      };
      const counts = await getCounts();

      res.json({
        success: true,
        message: 'Schema updated successfully',
        tables: tablesResult.rows.map(row => row.table_name),
        counts: {
          venues: parseInt(counts.venues),
          artists: parseInt(counts.artists),
          songs: parseInt(counts.songs),
          events: parseInt(counts.events)
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

  // =============================
  // USERS API ENDPOINTS
  // =============================

  // Public API: Get all users
  app.get('/api/users', async (req, res) => {
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const result = await pool.query(`
        SELECT
          id, supabase_id as "supabaseId", phone, email,
          first_name as "firstName", last_name as "lastName",
          display_name as "displayName", hometown, avatar_url as "avatarUrl",
          instrument, platform_admin as "platformAdmin",
          profile_completed as "profileCompleted",
          created_at as "createdAt", updated_at as "updatedAt"
        FROM users
        ORDER BY display_name NULLS LAST, first_name NULLS LAST, created_at DESC
      `);

      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // Admin API: Create user
  app.post('/admin/users', async (req, res) => {
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const {
        supabaseId, phone, email, firstName, lastName,
        displayName, hometown, avatarUrl, instrument, platformAdmin
      } = req.body;

      // Validate required fields for profile completion
      const profileCompleted = !!(firstName && lastName && displayName && hometown && instrument);

      const result = await pool.query(`
        INSERT INTO users (
          supabase_id, phone, email, first_name, last_name,
          display_name, hometown, avatar_url, instrument,
          platform_admin, profile_completed
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING
          id, supabase_id as "supabaseId", phone, email,
          first_name as "firstName", last_name as "lastName",
          display_name as "displayName", hometown, avatar_url as "avatarUrl",
          instrument, platform_admin as "platformAdmin",
          profile_completed as "profileCompleted",
          created_at as "createdAt", updated_at as "updatedAt"
      `, [
        supabaseId, phone, email, firstName, lastName,
        displayName, hometown, avatarUrl, instrument,
        platformAdmin || false, profileCompleted
      ]);

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error creating user:', error);
      if (error.code === '23505') { // Unique constraint violation
        return res.status(409).json({ error: 'User already exists with this phone/email/supabaseId' });
      }
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  // Admin API: Update user
  app.put('/admin/users/:id', async (req, res) => {
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const { id } = req.params;
      const updates = req.body;

      // Build dynamic update query
      const updateFields = [];
      const values = [];
      let paramIndex = 1;

      const allowedFields = [
        'phone', 'email', 'first_name', 'last_name', 'display_name',
        'hometown', 'avatar_url', 'instrument', 'platform_admin'
      ];

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          updateFields.push(`${field} = $${paramIndex}`);
          values.push(updates[field]);
          paramIndex++;
        }
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      // Always update the updated_at timestamp
      updateFields.push(`updated_at = NOW()`);

      // Check profile completion after update
      updateFields.push(`profile_completed = (
        first_name IS NOT NULL AND first_name != '' AND
        last_name IS NOT NULL AND last_name != '' AND
        display_name IS NOT NULL AND display_name != '' AND
        hometown IS NOT NULL AND hometown != '' AND
        instrument IS NOT NULL AND instrument != ''
      )`);

      values.push(id);

      const result = await pool.query(`
        UPDATE users
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING
          id, supabase_id as "supabaseId", phone, email,
          first_name as "firstName", last_name as "lastName",
          display_name as "displayName", hometown, avatar_url as "avatarUrl",
          instrument, platform_admin as "platformAdmin",
          profile_completed as "profileCompleted",
          created_at as "createdAt", updated_at as "updatedAt"
      `, values);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error updating user:', error);
      if (error.code === '23505') { // Unique constraint violation
        return res.status(409).json({ error: 'Phone or email already in use' });
      }
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // Admin API: Delete user
  app.delete('/admin/users/:id', async (req, res) => {
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const { id } = req.params;

      const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // Admin API: Get user by supabaseId (for auth integration)
  app.get('/admin/users/by-supabase/:supabaseId', async (req, res) => {
    try {
      const pool = getPool();
      if (!pool) {
        return res.status(500).json({ error: 'Pool not available' });
      }

      const { supabaseId } = req.params;

      const result = await pool.query(`
        SELECT
          id, supabase_id as "supabaseId", phone, email,
          first_name as "firstName", last_name as "lastName",
          display_name as "displayName", hometown, avatar_url as "avatarUrl",
          instrument, platform_admin as "platformAdmin",
          profile_completed as "profileCompleted",
          created_at as "createdAt", updated_at as "updatedAt"
        FROM users
        WHERE supabase_id = $1
      `, [supabaseId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error fetching user by supabaseId:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });
};
