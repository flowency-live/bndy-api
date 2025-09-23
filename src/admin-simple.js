// Simplest possible admin endpoint to test database connection

module.exports = function(app, pool, initializeDatabase) {
  console.log('🔧 Adding simple admin endpoints...');

  app.get('/admin/test', (req, res) => {
    res.json({ message: 'Admin routes working!', timestamp: new Date().toISOString() });
  });

  app.get('/admin/db-test', async (req, res) => {
    console.log('🔍 Testing database connection...');
    try {
      if (!await initializeDatabase()) {
        console.log('❌ Database init failed');
        return res.status(500).json({ error: 'Database connection failed' });
      }
      
      console.log('✅ Database init successful, testing query...');
      const result = await pool.query('SELECT COUNT(*) FROM venues');
      console.log('✅ Query successful');
      
      res.json({ 
        success: true, 
        venueCount: result.rows[0].count,
        timestamp: new Date().toISOString() 
      });
    } catch (error) {
      console.error('❌ Database test failed:', error);
      res.status(500).json({ error: 'Database test failed', details: error.message });
    }
  });

  app.post('/admin/create-table', async (req, res) => {
    console.log('📋 Starting table creation...');
    try {
      if (!await initializeDatabase()) {
        return res.status(500).json({ error: 'Database connection failed' });
      }

      console.log('📋 Creating test_artists table...');
      await pool.query('CREATE TABLE IF NOT EXISTS test_artists (id SERIAL PRIMARY KEY, name TEXT)');
      console.log('✅ Table created successfully');

      res.json({ success: true, message: 'Table created', timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('❌ Table creation failed:', error);
      res.status(500).json({ error: 'Table creation failed', details: error.message });
    }
  });
};
