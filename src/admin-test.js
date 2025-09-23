// Simple test to add one admin endpoint inline

module.exports = function(app, pool, initializeDatabase) {
  console.log('🔧 Adding test admin endpoint...');

  // Simple test endpoint
  app.get('/admin/test', (req, res) => {
    res.json({ message: 'Admin routes working!', timestamp: new Date().toISOString() });
  });

  // Schema update endpoint
  app.post('/admin/update-schema', async (req, res) => {
    try {
      console.log('🏗️ Admin: Updating schema for artists and songs...');

      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      await pool.query('BEGIN');

      // Simple test - just create artists table
      console.log('📋 Creating artists table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS artists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          bio TEXT,
          location VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      await pool.query('COMMIT');

      res.json({
        success: true,
        message: 'Schema updated successfully',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('❌ Schema update failed:', error);
      res.status(500).json({ error: 'Schema update failed', details: error.message });
    }
  });
};