import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

async function run() {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);
  // Connect without database to allow CREATE DATABASE
  const bootstrap = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    multipleStatements: true,
  });
  const ddl = await fs.readFile(path.resolve('sql/001_init.sql'), 'utf-8');
  await bootstrap.query(ddl);
  await bootstrap.end();

  // Now connect with database and seed users
  const conn = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: dbName,
  });
  const users = JSON.parse(await fs.readFile(path.resolve('seed/users.json'), 'utf-8'));
  for (const u of users) {
    await conn.query('INSERT IGNORE INTO users (id, token, display_name) VALUES (?, ?, ?)',
      [u.id, u.token, u.display_name]);
  }
  logger.info({ users: users.length }, 'init_db_complete');
  await conn.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
