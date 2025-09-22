# BNDY API

Express.js API backend for the BNDY platform, providing venue and event data for bndy-live.

## Overview

This API serves as the backend for the BNDY platform, currently focused on:
- Venue data endpoints for bndy-live map functionality
- Admin endpoints for data import and management
- PostgreSQL integration via AWS Aurora Serverless v2

## Tech Stack

- **Runtime:** Node.js 18
- **Framework:** Express.js
- **Database:** PostgreSQL (AWS Aurora Serverless v2)
- **Deployment:** AWS App Runner
- **Region:** eu-west-2

## API Endpoints

### Public Endpoints (No Auth)
- `GET /health` - Health check endpoint
- `GET /api/venues` - Get all venues for map display
- `GET /api/venues/:id` - Get single venue details

### Admin Endpoints
- `POST /admin/import-venues` - Import venue data from JSON

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3001)
- `DATABASE_URL` - PostgreSQL connection string
- `AWS_DEFAULT_REGION` - AWS region for services

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your database connection
   ```

3. Run the server:
   ```bash
   npm start
   ```

4. Development mode with auto-reload:
   ```bash
   npm run dev
   ```

## Deployment

This API is deployed to AWS App Runner and automatically deploys on push to the main branch.

## Database Schema

The API uses PostgreSQL with the following main tables:
- `venues` - Venue information with location data
- `artists` - Artist profiles (future use)
- `events` - Event listings (future use)

## Project Structure

```
bndy-api/
├── src/
│   └── index.js       # Main Express server
├── package.json       # Dependencies
├── Dockerfile        # Container configuration
└── README.md        # This file
```

## Related Repositories

- [bndy-live](https://github.com/flowency-live/bndy-live) - Frontend venue discovery platform
- [bndy-infrastructure](https://github.com/flowency-live/bndy-infrastructure) - Infrastructure as Code
- [bndy-centrestage](https://github.com/flowency-live/bndy-centrestage) - Admin interface