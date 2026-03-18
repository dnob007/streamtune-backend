'use strict';
/**
 * Script de inicio para produccion.
 * Ejecuta el seed si la BD esta vacia, luego arranca el servidor.
 */
const { execSync } = require('child_process');
const path = require('path');

async function start() {
  // Solo ejecutar seed si hay usuarios (tabla vacia = primer arranque)
  try {
    require('dotenv').config();
    const { sequelize, User } = require('./src/models');
    await sequelize.authenticate();
    const count = await User.count();
    if (count === 0) {
      console.log('Base de datos vacia - ejecutando seed...');
      execSync('node src/utils/seed.js', { stdio: 'inherit' });
      console.log('Seed completado');
    } else {
      console.log(`Base de datos lista (${count} usuarios existentes)`);
    }
    await sequelize.close();
  } catch (err) {
    console.error('Error verificando BD:', err.message);
  }

  // Arrancar el servidor
  require('./src/server.js');
}

start();
