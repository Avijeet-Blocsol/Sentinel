/**
 * Strands Sentinel - Backend Server Entrypoint
 * Barebones setup - No endpoints configured yet
 */
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || '0.0.0.0',
  databasePath: process.env.DATABASE_PATH || './data/sentinel.db',
};

console.log('⚡ Strands Sentinel Server initialized (Barebones setup)');
