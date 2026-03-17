'use strict';
require('dotenv').config();
const { sequelize } = require('../models');
const config = require('../../config');

async function migrate() {
  const tipo = config.isPostgres ? 'PostgreSQL' : 'SQLite';
  console.log(`Conectando a ${tipo}...`);
  await sequelize.authenticate();
  console.log('Sincronizando tablas...');
  await sequelize.sync({ force: false });
  console.log('Tablas sincronizadas correctamente');
  await sequelize.close();
}

migrate().catch(err => { console.error(err.message); process.exit(1); });
