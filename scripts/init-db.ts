import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

async function run() {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);

  const ddl = await fs.readFile(path.resolve('sql/001_init.sql'), 'utf-8');

  // Split DDL: setup (CREATE DATABASE + USE) and tables (CREATE TABLE statements)
  const useIdx = ddl.toLowerCase().indexOf('use seatres;');
  const setupSql = ddl.slice(0, useIdx + 'use seatres;'.length);
  const tablesSql = ddl.slice(useIdx + 'use seatres;'.length);

  // Try to create database; fail gracefully if no privilege (DB already exists)
  const bootstrap = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    multipleStatements: true,
  });
  try {
    try {
      await bootstrap.query(setupSql);
    } catch (e: any) {
      const skippable = e?.code === 'ER_DBACCESS_DENIED_ERROR' ||
                        e?.code === 'ER_DB_CREATE_EXISTS' ||
                        e?.errno === 1044 ||
                        e?.errno === 1007;
      if (!skippable) throw e;
      logger.warn({ code: e?.code, errno: e?.errno }, 'skipping CREATE DATABASE (likely exists or no CREATE privilege)');
    }
  } finally {
    await bootstrap.end();
  }

  // Now connect with database and create tables
  const conn = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: dbName,
    multipleStatements: true,
  });
  try {
    await conn.query(tablesSql);

    const users = JSON.parse(await fs.readFile(path.resolve('seed/users.json'), 'utf-8'));
    for (const u of users) {
      await conn.query('INSERT IGNORE INTO users (id, token, display_name) VALUES (?, ?, ?)',
        [u.id, u.token, u.display_name]);
    }
    logger.info({ users: users.length }, 'init_db_complete');
  } finally {
    await conn.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
