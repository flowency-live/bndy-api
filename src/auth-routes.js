// BNDY Platform Authentication Routes
// Production-grade server-side OAuth implementation with secure cookies

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');

// AWS Cognito configuration
const cognito = new AWS.CognitoIdentityServiceProvider({ region: 'eu-west-2' });
const COGNITO_DOMAIN = 'https://eu-west-2lqtkkhs1p.auth.eu-west-2.amazoncognito.com';
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID || '5v481th8k6v9lqifnp5oppak89';
const CLIENT_SECRET = process.env.COGNITO_USER_POOL_CLIENT_SECRET;
const REDIRECT_URI = process.env.NODE_ENV === 'production'
  ? 'https://api.bndy.co.uk/auth/callback'
  : 'http://localhost:3001/auth/callback';

const FRONTEND_URL = process.env.NODE_ENV === 'production'
  ? 'https://backstage.bndy.co.uk'
  : 'http://localhost:5173';

function addAuthRoutes(app, getPool, initializeDatabase) {

  // Generate OAuth state for security
  const generateState = () => {
    return crypto.randomBytes(32).toString('hex');
  };

  // Store state temporarily (in production, use Redis)
  const stateStore = new Map();

  // OAuth login initiation
  app.get('/auth/google', (req, res) => {
    const state = generateState();

    // Store state with expiry (5 minutes)
    stateStore.set(state, {
      timestamp: Date.now(),
      origin: req.headers.referer || FRONTEND_URL
    });

    // Clean expired states
    for (const [key, value] of stateStore.entries()) {
      if (Date.now() - value.timestamp > 300000) { // 5 minutes
        stateStore.delete(key);
      }
    }

    const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
      `response_type=code&` +
      `client_id=${CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `scope=email+openid+profile+phone&` +
      `state=${state}&` +
      `identity_provider=Google`;

    console.log('🔐 AUTH: Initiating Google OAuth flow', {
      state: state.substring(0, 8) + '...',
      redirectUri: REDIRECT_URI
    });

    res.redirect(authUrl);
  });

  // OAuth callback handler
  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    console.log('🔐 AUTH CALLBACK: Received callback', {
      hasCode: !!code,
      hasState: !!state,
      error
    });

    try {
      // Verify state to prevent CSRF
      if (!state || !stateStore.has(state)) {
        console.error('🔐 AUTH CALLBACK: Invalid or expired state');
        return res.redirect(`${FRONTEND_URL}/login?error=invalid_state`);
      }

      const stateData = stateStore.get(state);
      stateStore.delete(state);

      if (error) {
        console.error('🔐 AUTH CALLBACK: OAuth error:', error);
        return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
      }

      if (!code) {
        console.error('🔐 AUTH CALLBACK: No authorization code received');
        return res.redirect(`${FRONTEND_URL}/login?error=no_code`);
      }

      // Exchange authorization code for tokens
      console.log('🔐 AUTH CALLBACK: Exchanging code for tokens');

      const tokenResponse = await axios.post(`${COGNITO_DOMAIN}/oauth2/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: code,
          redirect_uri: REDIRECT_URI,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const { access_token, id_token, refresh_token } = tokenResponse.data;
      console.log('🔐 AUTH CALLBACK: Token exchange successful');

      // Decode ID token to get user info
      const decodedIdToken = jwt.decode(id_token);
      const userId = decodedIdToken.sub;
      const email = decodedIdToken.email;
      const username = decodedIdToken['cognito:username'];

      console.log('🔐 AUTH CALLBACK: User authenticated', {
        userId: userId.substring(0, 8) + '...',
        email: email ? email.substring(0, 3) + '***' : 'N/A',
        username
      });

      // Create secure session
      const sessionData = {
        userId,
        username,
        email,
        accessToken: access_token,
        idToken: id_token,
        refreshToken: refresh_token,
        issuedAt: Date.now()
      };

      // Sign JWT session
      const sessionToken = jwt.sign(sessionData, process.env.JWT_SECRET || 'your-secret-key', {
        expiresIn: '7d'
      });

      // Set secure httpOnly cookie
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Change to 'none' for cross-origin
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        domain: process.env.NODE_ENV === 'production' ? '.bndy.co.uk' : undefined
      };

      console.log('🔐 AUTH CALLBACK: Setting cookie with options:', {
        domain: cookieOptions.domain,
        secure: cookieOptions.secure,
        sameSite: cookieOptions.sameSite,
        httpOnly: cookieOptions.httpOnly
      });

      res.cookie('bndy_session', sessionToken, cookieOptions);

      console.log('🔐 AUTH CALLBACK: Session created, redirecting to dashboard');

      // Use HTML redirect instead of HTTP redirect to ensure cookie is set
      res.send(`
        <html>
          <head>
            <title>Redirecting...</title>
            <script>
              // Give the browser time to set the cookie
              setTimeout(function() {
                window.location.href = '${FRONTEND_URL}/dashboard';
              }, 100);
            </script>
          </head>
          <body>
            <p>Authentication successful! Redirecting to dashboard...</p>
            <p>If you are not redirected, <a href="${FRONTEND_URL}/dashboard">click here</a>.</p>
          </body>
        </html>
      `);

    } catch (error) {
      console.error('🔐 AUTH CALLBACK: Token exchange failed:', error.message);
      res.redirect(`${FRONTEND_URL}/login?error=token_exchange_failed`);
    }
  });

  // Authentication middleware
  const requireAuth = (req, res, next) => {
    const sessionToken = req.cookies?.bndy_session;

    console.log('🔐 AUTH: Checking authentication', {
      hasCookies: !!req.cookies,
      cookieNames: req.cookies ? Object.keys(req.cookies) : [],
      hasSessionToken: !!sessionToken,
      origin: req.headers.origin,
      referer: req.headers.referer
    });

    if (!sessionToken) {
      console.log('🔐 AUTH: No session token found');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const session = jwt.verify(sessionToken, process.env.JWT_SECRET || 'your-secret-key');
      req.user = session;
      console.log('🔐 AUTH: User authenticated via session', {
        userId: session.userId.substring(0, 8) + '...'
      });
      next();
    } catch (error) {
      console.error('🔐 AUTH: Invalid session token:', error.message);
      res.clearCookie('bndy_session');
      return res.status(401).json({ error: 'Invalid session' });
    }
  };

  // Current user endpoint (required by BandGate)
  app.get('/api/me', requireAuth, async (req, res) => {
    try {
      console.log('🔐 API: /api/me called by authenticated user');

      // Initialize database if needed
      if (!getPool()) {
        await initializeDatabase();
      }

      const pool = getPool();

      // Look up user in database
      const userQuery = await pool.query(
        'SELECT id, email, phone_number, created_at FROM users WHERE cognito_id = $1',
        [req.user.userId]
      );

      let dbUser = null;
      if (userQuery.rows.length > 0) {
        dbUser = userQuery.rows[0];
        console.log('🔐 API: User found in database');
      } else {
        // Create user record if it doesn't exist
        console.log('🔐 API: Creating new user record in database');
        const insertResult = await pool.query(
          'INSERT INTO users (cognito_id, email, phone_number, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, email, phone_number, created_at',
          [req.user.userId, req.user.email, null]
        );
        dbUser = insertResult.rows[0];
      }

      // Check for user's bands
      const bandsQuery = await pool.query(`
        SELECT b.id, b.name, ub.role, ub.status
        FROM bands b
        JOIN user_bands ub ON b.id = ub.band_id
        WHERE ub.user_id = $1 AND ub.status = 'active'
      `, [dbUser.id]);

      const userBands = bandsQuery.rows;
      console.log(`🔐 API: User has ${userBands.length} active bands`);

      res.json({
        user: {
          id: dbUser.id,
          cognitoId: req.user.userId,
          username: req.user.username,
          email: req.user.email,
          createdAt: dbUser.created_at
        },
        bands: userBands,
        session: {
          issuedAt: req.user.issuedAt,
          expiresAt: req.user.exp * 1000 // JWT exp is in seconds
        }
      });

    } catch (error) {
      console.error('🔐 API: /api/me error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Logout endpoint
  app.post('/auth/logout', (req, res) => {
    console.log('🔐 AUTH: User logging out');
    res.clearCookie('bndy_session');
    res.json({ success: true });
  });

  // Session check endpoint
  app.get('/auth/session', requireAuth, (req, res) => {
    res.json({
      authenticated: true,
      user: {
        id: req.user.userId,
        username: req.user.username,
        email: req.user.email
      }
    });
  });

  console.log('🔐 AUTH: Authentication routes registered');
  console.log(`🔗 OAuth: ${process.env.NODE_ENV === 'production' ? 'https://4kxjn4gjqj.eu-west-2.awsapprunner.com' : 'http://localhost:3001'}/auth/google`);
}

module.exports = addAuthRoutes;