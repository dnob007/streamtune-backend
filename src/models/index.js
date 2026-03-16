'use strict';
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const config = require('../../config');
const logger = require('../utils/logger');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: config.db.storage,
  logging: false,   // silencia SQL en consola para mayor claridad
});

// ── MODEL: User ──────────────────────────────────────────
const User = sequelize.define('User', {
  id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  username:      { type: DataTypes.STRING(30),  allowNull: false, unique: true },
  email:         { type: DataTypes.STRING(120), allowNull: false, unique: true },
  passwordHash:  { type: DataTypes.STRING,      allowNull: false },
  displayName:   { type: DataTypes.STRING(60) },
  country:       { type: DataTypes.STRING(2) },
  role:          { type: DataTypes.STRING(10),  defaultValue: 'viewer' },
  creditBalance: { type: DataTypes.INTEGER,     defaultValue: 0 },
  isVerified:    { type: DataTypes.BOOLEAN,     defaultValue: false },
  avatarUrl:     { type: DataTypes.STRING },
  lastSeenAt:    { type: DataTypes.DATE },
}, { tableName: 'users', underscored: true });

// ── MODEL: Channel ───────────────────────────────────────
const Channel = sequelize.define('Channel', {
  id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  ownerId:     { type: DataTypes.UUID, allowNull: false },
  slug:        { type: DataTypes.STRING(40), allowNull: false, unique: true },
  name:        { type: DataTypes.STRING(80), allowNull: false },
  description: { type: DataTypes.STRING(120) },
  descLong:    { type: DataTypes.TEXT },
  icon:        { type: DataTypes.STRING(8),  defaultValue: '🎵' },
  accentColor: { type: DataTypes.STRING(7),  defaultValue: '#7c5cfc' },
  topics: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() {
      const v = this.getDataValue('topics');
      if (!v) return [];
      if (Array.isArray(v)) return v;
      try { return JSON.parse(v); } catch { return []; }
    },
    set(val) {
      this.setDataValue('topics', JSON.stringify(Array.isArray(val) ? val : []));
    },
  },
  plan:             { type: DataTypes.STRING(10), defaultValue: 'free' },
  status:           { type: DataTypes.STRING(10), defaultValue: 'offline' },
  followerCount:    { type: DataTypes.INTEGER, defaultValue: 0 },
  storageBytesUsed: { type: DataTypes.INTEGER, defaultValue: 0 },
  timezone:         { type: DataTypes.STRING(50), defaultValue: 'America/Mexico_City' },
}, { tableName: 'channels', underscored: true });

// ── MODEL: Video ─────────────────────────────────────────
const Video = sequelize.define('Video', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  channelId:    { type: DataTypes.UUID, allowNull: false },
  source:       { type: DataTypes.STRING(10), allowNull: false },
  ytId:         { type: DataTypes.STRING(20) },
  ytTitle:      { type: DataTypes.STRING(200) },
  ytChannel:    { type: DataTypes.STRING(100) },
  ytDuration:   { type: DataTypes.INTEGER },
  ytEmbeddable: { type: DataTypes.BOOLEAN, defaultValue: true },
  fileKey:      { type: DataTypes.STRING },
  fileSize:     { type: DataTypes.INTEGER },
  fileDuration: { type: DataTypes.INTEGER },
  title:        { type: DataTypes.STRING(200) },
  durationSec: {
    type: DataTypes.VIRTUAL,
    get() { return this.fileDuration || this.ytDuration || 0; },
  },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'videos', underscored: true });

// ── MODEL: DailySchedule ─────────────────────────────────
const DailySchedule = sequelize.define('DailySchedule', {
  id:        { type: DataTypes.UUID,    defaultValue: DataTypes.UUIDV4, primaryKey: true },
  channelId: { type: DataTypes.UUID,    allowNull: false },
  dayOfWeek: { type: DataTypes.INTEGER, allowNull: false },
  videoIds: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() {
      const v = this.getDataValue('videoIds');
      if (!v) return [];
      if (Array.isArray(v)) return v;
      try { return JSON.parse(v); } catch { return []; }
    },
    set(val) {
      this.setDataValue('videoIds', JSON.stringify(Array.isArray(val) ? val : []));
    },
  },
  shuffle:      { type: DataTypes.BOOLEAN, defaultValue: false },
  loop:         { type: DataTypes.BOOLEAN, defaultValue: true },
  crossfadeSec: { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  tableName: 'daily_schedules',
  underscored: true,
  indexes: [{ unique: true, fields: ['channel_id', 'day_of_week'] }],
});

// ── MODEL: CreditTransaction ─────────────────────────────
const CreditTransaction = sequelize.define('CreditTransaction', {
  id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  fromUserId:      { type: DataTypes.UUID },
  toUserId:        { type: DataTypes.UUID },
  channelId:       { type: DataTypes.UUID },
  amount:          { type: DataTypes.INTEGER, allowNull: false },
  type:            { type: DataTypes.STRING(10), allowNull: false },
  stripePaymentId: { type: DataTypes.STRING },
  usdAmount:       { type: DataTypes.FLOAT },
  meta: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    get() {
      const v = this.getDataValue('meta');
      if (!v) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch { return {}; }
    },
    set(val) {
      this.setDataValue('meta', JSON.stringify(val ?? {}));
    },
  },
}, { tableName: 'credit_transactions', underscored: true });

// ── MODEL: Follow ────────────────────────────────────────
const Follow = sequelize.define('Follow', {
  userId:    { type: DataTypes.UUID, allowNull: false },
  channelId: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'follows',
  underscored: true,
  indexes: [{ unique: true, fields: ['user_id', 'channel_id'] }],
});

// ── MODEL: ChatMessage ───────────────────────────────────
const ChatMessage = sequelize.define('ChatMessage', {
  id:        { type: DataTypes.UUID,        defaultValue: DataTypes.UUIDV4, primaryKey: true },
  channelId: { type: DataTypes.UUID,        allowNull: false },
  userId:    { type: DataTypes.UUID,        allowNull: false },
  body:      { type: DataTypes.STRING(500), allowNull: false },
  type:      { type: DataTypes.STRING(10),  defaultValue: 'text' },
  creditAmt: { type: DataTypes.INTEGER,     defaultValue: 0 },
  deletedAt: { type: DataTypes.DATE },
}, { tableName: 'chat_messages', underscored: true });

// ── Asociaciones ─────────────────────────────────────────
Channel.belongsTo(User,         { foreignKey: 'ownerId',   as: 'owner'    });
User.hasMany(Channel,           { foreignKey: 'ownerId',   as: 'channels' });
Channel.hasMany(Video,          { foreignKey: 'channelId', as: 'videos'   });
Video.belongsTo(Channel,        { foreignKey: 'channelId'                 });
Channel.hasMany(DailySchedule,  { foreignKey: 'channelId', as: 'schedules'});
Channel.hasMany(ChatMessage,    { foreignKey: 'channelId', as: 'messages' });
User.hasMany(ChatMessage,       { foreignKey: 'userId'                    });
User.hasMany(CreditTransaction, { foreignKey: 'fromUserId', as: 'sent'    });
User.hasMany(CreditTransaction, { foreignKey: 'toUserId',   as: 'received'});

// ── connectDB ─────────────────────────────────────────────
async function connectDB() {
  await sequelize.authenticate();

  // sync({ force: false }) solo CREA tablas que no existen.
  // NUNCA borra ni modifica tablas existentes con datos.
  // Es la opcion segura para desarrollo con datos ya cargados.
  await sequelize.sync({ force: false });

  logger.info('SQLite conectado -> ' + config.db.storage);
}

module.exports = {
  sequelize, connectDB,
  User, Channel, Video, DailySchedule,
  CreditTransaction, Follow, ChatMessage,
};
