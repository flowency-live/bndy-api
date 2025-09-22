// BNDY Platform Unified API
// Express.js backend for bndy-live venue map and admin interface

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

AWS.config.update({ region: 'eu-west-2' });
const ssm = new AWS.SSM();

let pool;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database connection...');

    let connectionString;

    if (process.env.DATABASE_URL) {
      connectionString = process.env.DATABASE_URL;
      console.log('✅ Using DATABASE_URL from environment');
    } else {
      console.log('🔍 Retrieving connection string from Parameter Store...');
      const parameter = await ssm.getParameter({
        Name: '/bndy/production/aurora/connection-string',
        WithDecryption: true
      }).promise();

      connectionString = parameter.Parameter.Value;
      console.log('✅ Retrieved connection string from Parameter Store');
    }

    pool = new Pool({
      connectionString: connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    const client = await pool.connect();
    console.log('✅ Database connection successful');

    const result = await client.query('SELECT COUNT(*) as venue_count FROM venues');
    const venueCount = result.rows[0].venue_count;
    console.log(`📊 Found ${venueCount} venues in database`);

    client.release();
    return true;

  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);

    if (error.message.includes('relation "venues" does not exist')) {
      console.log('🏗️ Tables not found, attempting to initialize schema...');
      return await initializeSchema();
    }

    throw error;
  }
}

async function initializeSchema() {
  try {
    console.log('🏗️ Creating database schema...');

    const client = await pool.connect();

    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await client.query(`
      CREATE TABLE IF NOT EXISTS venues (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        address TEXT NOT NULL,
        latitude DECIMAL(10, 8) NOT NULL DEFAULT 0,
        longitude DECIMAL(11, 8) NOT NULL DEFAULT 0,
        location_object JSONB DEFAULT '{}',
        google_place_id VARCHAR(255) UNIQUE,
        validated BOOLEAN DEFAULT false,
        name_variants TEXT[] DEFAULT '{}',
        phone VARCHAR(50) DEFAULT '',
        postcode VARCHAR(20) DEFAULT '',
        profile_image_url TEXT,
        facilities TEXT[] DEFAULT '{}',
        social_media_urls JSONB DEFAULT '[]',
        standard_ticketed BOOLEAN DEFAULT false,
        standard_ticket_information TEXT DEFAULT '',
        standard_ticket_url TEXT DEFAULT '',
        migrated_from_id VARCHAR(255),
        source_platform VARCHAR(50) DEFAULT 'bndy-live',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_venues_location ON venues (latitude, longitude)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_venues_name ON venues (name)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_venues_google_place_id ON venues (google_place_id)');

    client.release();
    console.log('✅ Database schema initialized');
    return true;

  } catch (error) {
    console.error('❌ Schema initialization failed:', error);
    throw error;
  }
}

// GET all venues (for bndy-live map)
app.get('/api/venues', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, address,
        location_object as location,
        google_place_id as "googlePlaceId",
        validated, profile_image_url as "profileImageUrl"
      FROM venues
      WHERE latitude != 0 AND longitude != 0
      ORDER BY validated DESC, name ASC
    `);

    console.log(`📍 Served ${result.rows.length} venues to client`);
    res.json(result.rows);

  } catch (error) {
    console.error('❌ Error fetching venues:', error);
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
});

// GET single venue by ID
app.get('/api/venues/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, address,
        latitude, longitude,
        location_object as location,
        google_place_id as "googlePlaceId",
        validated, name_variants as "nameVariants",
        phone, postcode, profile_image_url as "profileImageUrl",
        facilities, social_media_urls as "socialMediaURLs",
        standard_ticketed as "standardTicketed",
        standard_ticket_information as "standardTicketInformation",
        standard_ticket_url as "standardTicketUrl",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM venues
      WHERE id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Venue not found' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('❌ Error fetching venue:', error);
    res.status(500).json({ error: 'Failed to fetch venue' });
  }
});

// Admin endpoint - Import venues
app.post('/admin/import-venues', async (req, res) => {
  try {
    const { venues } = req.body;

    if (!venues || !Array.isArray(venues)) {
      return res.status(400).json({ error: 'Invalid venues data' });
    }

    console.log(`🔄 Starting import of ${venues.length} venues...`);
    let imported = 0;
    let skipped = 0;

    for (const venue of venues) {
      try {
        await pool.query(`
          INSERT INTO venues (
            name, address, latitude, longitude, location_object,
            google_place_id, validated, name_variants, phone, postcode,
            profile_image_url, facilities, social_media_urls,
            standard_ticketed, standard_ticket_information, standard_ticket_url,
            migrated_from_id, source_platform
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
          ON CONFLICT (google_place_id) DO UPDATE SET
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            location_object = EXCLUDED.location_object,
            updated_at = NOW()
        `, [
          venue.name || '',
          venue.address || '',
          venue.location?.lat || 0,
          venue.location?.lng || 0,
          JSON.stringify(venue.location || { lat: 0, lng: 0 }),
          venue.googlePlaceId || null,
          venue.validated || false,
          venue.nameVariants || [],
          venue.phone || '',
          venue.postcode || '',
          venue.profileImageUrl || null,
          venue.facilities || [],
          venue.socialMediaURLs || [],
          venue.standardTicketed || false,
          venue.standardTicketInformation || '',
          venue.standardTicketUrl || '',
          venue.firestore_id || null,
          'bndy-live'
        ]);

        imported++;

      } catch (venueError) {
        console.warn(`⚠️ Skipping venue ${venue.name}: ${venueError.message}`);
        skipped++;
      }
    }

    console.log(`✅ Import complete: ${imported} imported, ${skipped} skipped`);

    res.json({
      success: true,
      imported,
      skipped,
      total: venues.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Import failed:', error);
    res.status(500).json({ error: 'Import failed', details: error.message });
  }
});

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log('🚀 BNDY API Server Started');
      console.log(`📡 Listening on port ${PORT}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
      console.log(`📍 Venues API: http://localhost:${PORT}/api/venues`);
    });

  } catch (error) {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down server...');
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

startServer();