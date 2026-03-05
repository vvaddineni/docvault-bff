// bff/src/routes/documents.js
// ============================================================
// Documents API routes — all forwarded through Azure APIM
// to the Spring Boot Document Service.
//
// APIM routes:  /documents/v1/**  →  document-service:8080
// ============================================================

const express  = require('express');
const multer   = require('multer');
const FormData = require('form-data');
const asyncH   = require('express-async-handler');
const axios    = require('axios');
const apim     = require('../services/apimClient');
const logger   = require('../utils/logger');

const router  = express.Router();
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },   // 100 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel', 'text/plain', 'text/csv',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── GET /api/documents — list with pagination + filters ───────────────────
router.get('/', asyncH(async (req, res) => {
  const { page = 1, limit = 25, tier, department, sortBy = 'uploadedAt', order = 'desc' } = req.query;
  // Spring Pageable is 0-based; frontend sends 1-based page numbers
  const data = await apim.get('/documents/v1/documents', { page: page - 1, size: limit, tier, department, sortBy, order }, req.correlationId);
  res.json(data);
}));

// ── GET /api/documents/stats — aggregated storage stats ──────────────────
router.get('/stats', asyncH(async (req, res) => {
  const data = await apim.get('/documents/v1/documents/stats', {}, req.correlationId);
  res.json(data);
}));

// ── POST /api/documents/reindex — bulk re-index into Azure AI Search ─────
router.post('/reindex', asyncH(async (req, res) => {
  logger.info(`[Documents] Reindex all [${req.correlationId}]`);
  const data = await apim.post('/documents/v1/documents/reindex', {}, req.correlationId);
  res.status(202).json(data);
}));

// ── POST /api/documents/migrate — manual Hot→Cool migration trigger ───────
router.post('/migrate', asyncH(async (req, res) => {
  logger.info(`[Documents] Manual migration trigger [${req.correlationId}]`);
  const data = await apim.post('/documents/v1/documents/migrate', {}, req.correlationId);
  res.status(202).json(data);
}));

// ── GET /api/documents/search — standard metadata search (Cosmos DB) ─────
router.get('/search', asyncH(async (req, res) => {
  const { q = '', page = 1, limit = 25 } = req.query;
  const data = await apim.get(
    '/documents/v1/documents/search',
    { q, page: page - 1, size: limit },
    req.correlationId
  );
  // Transform Spring Page → { results, count } to match AI Search shape
  res.json({ results: data.content || [], count: data.totalElements || 0 });
}));

// ── GET /api/documents/:id — single document metadata ────────────────────
router.get('/:id', asyncH(async (req, res) => {
  const data = await apim.get(`/documents/v1/documents/${req.params.id}`, {}, req.correlationId);
  res.json(data);
}));

// ── POST /api/documents/upload — multipart upload ─────────────────────────
// BFF receives the file from React, re-streams to APIM → Document Service
router.post('/upload', upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  logger.info(`[Documents] Upload: ${req.file.originalname} (${req.file.size} bytes) [${req.correlationId}]`);

  // Re-build multipart for APIM
  const form = new FormData();
  form.append('file', req.file.buffer, {
    filename:    req.file.originalname,
    contentType: req.file.mimetype,
    knownLength: req.file.size,
  });
  form.append('metadata', req.body.metadata || '{}', { contentType: 'application/json' });

  const data = await apim.upload('/documents/v1/documents', form, req.correlationId);
  res.status(201).json(data);
}));

// ── GET /api/documents/:id/file — stream document directly to browser ────────
router.get('/:id/file', asyncH(async (req, res) => {
  const data = await apim.get(
    `/documents/v1/documents/${req.params.id}/download`,
    {},
    req.correlationId
  );

  if (data.status === 'rehydrating') {
    return res.status(202).json({ error: 'Document is being rehydrated from Archive. Try again later.' });
  }
  if (!data.sasUrl) {
    return res.status(404).json({ error: 'Download URL not available' });
  }

  logger.info(`[Documents] Streaming file: docId=${req.params.id} [${req.correlationId}]`);
  const fileRes = await axios.get(data.sasUrl, { responseType: 'stream' });
  res.setHeader('Content-Type', fileRes.headers['content-type'] || 'application/octet-stream');
  res.setHeader('Content-Disposition', fileRes.headers['content-disposition'] || 'attachment');
  if (fileRes.headers['content-length']) {
    res.setHeader('Content-Length', fileRes.headers['content-length']);
  }
  fileRes.data.pipe(res);
}));

// ── GET /api/documents/:id/download — SAS URL or rehydration status ───────
router.get('/:id/download', asyncH(async (req, res) => {
  const { priority = 'Standard' } = req.query;
  const data = await apim.get(
    `/documents/v1/documents/${req.params.id}/download`,
    { priority },
    req.correlationId
  );
  // 202 = still rehydrating, 200 = SAS URL ready
  const status = data.status === 'rehydrating' ? 202 : 200;
  res.status(status).json(data);
}));

// ── POST /api/documents/:id/rehydrate — initiate Archive rehydration ──────
router.post('/:id/rehydrate', asyncH(async (req, res) => {
  const { priority = 'Standard' } = req.body;
  logger.info(`[Documents] Rehydrate: docId=${req.params.id} priority=${priority} [${req.correlationId}]`);
  const data = await apim.post(
    `/documents/v1/documents/${req.params.id}/rehydrate`,
    { priority },
    req.correlationId
  );
  res.status(202).json(data);
}));

// ── PATCH /api/documents/:id — update metadata ────────────────────────────
router.patch('/:id', asyncH(async (req, res) => {
  const data = await apim.patch(
    `/documents/v1/documents/${req.params.id}`,
    req.body,
    req.correlationId
  );
  res.json(data);
}));

// ── DELETE /api/documents/:id ─────────────────────────────────────────────
router.delete('/:id', asyncH(async (req, res) => {
  logger.info(`[Documents] Delete: docId=${req.params.id} [${req.correlationId}]`);
  await apim.del(`/documents/v1/documents/${req.params.id}`, req.correlationId);
  res.status(204).end();
}));

module.exports = router;
