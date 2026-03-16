'use strict';
/**
 * Para SQLite no se necesita migración manual.
 * Sequelize.sync({ alter: true }) crea/actualiza las tablas
 * automáticamente al arrancar el servidor.
 *
 * Este script solo verifica la conexión.
 */
require('dotenv').config();
const { sequelize } = require('../models');

async function migrate() {
  console.log('SQLite: sincronizando tablas...');
  await sequelize.sync({ alter: true });
  console.log('✓ Tablas sincronizadas en:', require('../../config').db.storage);
  await sequelize.close();
}

migrate().catch(err => { console.error(err); process.exit(1); });
