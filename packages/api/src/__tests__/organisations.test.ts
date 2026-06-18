import request from 'supertest';
import type { Knex } from 'knex';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApp } from '../app';
import { startTestDb, stopTestDb, cleanDb } from './helpers';

describe('Organisations', () => {
  let app: ReturnType<typeof createApp>;
  let db: Knex;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    ({ db, container } = await startTestDb());
    app = createApp(db);
  }, 90_000);

  afterAll(async () => {
    await stopTestDb({ db, container });
  });

  beforeEach(async () => {
    await cleanDb(db);
  });

  // ── POST /organisations ────────────────────────────────────────────────────

  it('creates an organisation and returns 201', async () => {
    const res = await request(app).post('/organisations').send({
      name: 'Acme Ltd',
      jurisdiction: 'GB',
      residency: 'GB',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Acme Ltd',
      jurisdiction: 'GB',
      residency: 'GB',
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.created_at).toBeDefined();
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/organisations').send({
      jurisdiction: 'GB',
      residency: 'GB',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when jurisdiction is missing', async () => {
    const res = await request(app).post('/organisations').send({
      name: 'Acme Ltd',
      residency: 'GB',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when residency is missing', async () => {
    const res = await request(app).post('/organisations').send({
      name: 'Acme Ltd',
      jurisdiction: 'GB',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('strips leading/trailing whitespace from string fields', async () => {
    const res = await request(app).post('/organisations').send({
      name: '  Acme Ltd  ',
      jurisdiction: ' GB ',
      residency: ' GB ',
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Acme Ltd');
    expect(res.body.jurisdiction).toBe('GB');
    expect(res.body.residency).toBe('GB');
  });

  // ── GET /organisations/:org_id ─────────────────────────────────────────────

  it('returns an organisation by id', async () => {
    const create = await request(app).post('/organisations').send({
      name: 'Acme Ltd',
      jurisdiction: 'GB',
      residency: 'GB',
    });
    const { id } = create.body as { id: string };

    const res = await request(app).get(`/organisations/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe('Acme Ltd');
  });

  it('returns 404 for unknown organisation id', async () => {
    const res = await request(app).get('/organisations/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── GET /organisations ─────────────────────────────────────────────────────

  it('lists all organisations', async () => {
    await request(app)
      .post('/organisations')
      .send({ name: 'Org A', jurisdiction: 'GB', residency: 'GB' });
    await request(app)
      .post('/organisations')
      .send({ name: 'Org B', jurisdiction: 'US', residency: 'US' });

    const res = await request(app).get('/organisations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((o: { name: string }) => o.name)).toEqual(['Org A', 'Org B']);
  });

  it('returns an empty array when no organisations exist', async () => {
    const res = await request(app).get('/organisations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
