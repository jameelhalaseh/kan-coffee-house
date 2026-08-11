// /api/category-images — user-uploaded artwork for a category tile.
//
// The browser normalises every upload to a 512x512 PNG before sending it. This suite is
// about what happens when something ISN'T the browser: the endpoint is reachable with a
// session and a curl command, and whatever it accepts is later served back to every till as
// an image. So the bytes are re-validated server-side, and these tests pin that.
const request = require('supertest');
const { seedUsers, login, auth, app, db } = require('./helpers');

let adminToken;
let cashierToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
});

beforeEach(() => db.query('delete from category_images'));
afterAll(() => db.pool.end());

// Build a real PNG of the given dimensions: signature + a correctly-CRC'd IHDR. Enough for
// the header validation under test, without pulling in an image library.
function png(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;          // 8-bit RGBA
  return Buffer.concat([sig, ihdr, Buffer.alloc(64)]);
}

const put = (token, cat, data) =>
  request(app).put(`/api/category-images/${encodeURIComponent(cat)}`).set(...auth(token)).send({ data });
const get = (token, cat) =>
  request(app).get(`/api/category-images/${encodeURIComponent(cat)}`).set(...auth(token));
const list = (token) => request(app).get('/api/category-images').set(...auth(token));

describe('uploading', () => {
  test('stores a valid 512x512 PNG and serves it back', async () => {
    const buf = png(512, 512);
    const res = await put(adminToken, 'Whiskey', buf.toString('base64'));
    expect(res.status).toBe(200);

    const img = await get(adminToken, 'Whiskey');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.from(img.body).subarray(0, 8)).toEqual(buf.subarray(0, 8));
  });

  test('accepts a full data: URL, not just bare base64', async () => {
    // canvas.toDataURL() hands the client a data: URL; making the route take it as-is keeps
    // string surgery out of the call site, where it would eventually be got wrong.
    const data = 'data:image/png;base64,' + png(512, 512).toString('base64');
    expect((await put(adminToken, 'Gin', data)).status).toBe(200);
  });

  test('replacing an image overwrites rather than adding a second row', async () => {
    await put(adminToken, 'Rum', png(512, 512).toString('base64'));
    await put(adminToken, 'Rum', png(512, 512).toString('base64'));
    const { rows } = await db.query("select count(*)::int as n from category_images where cat = 'rum'");
    expect(rows[0].n).toBe(1);
  });

  test('the category key is case- and space-insensitive', async () => {
    // The tile resolves artwork by lowercased name; if the two disagreed, an upload would
    // save successfully and then never appear.
    await put(adminToken, '  WHISKEY  ', png(512, 512).toString('base64'));
    expect((await get(adminToken, 'whiskey')).status).toBe(200);
    expect((await list(adminToken)).body.map((r) => r.cat)).toEqual(['whiskey']);
  });
});

describe('what the server refuses to store', () => {
  test('anything that is not a PNG', async () => {
    for (const junk of [Buffer.from('GIF89a...'), Buffer.from('<svg onload=alert(1)>'), Buffer.from('hello')]) {
      const res = await put(adminToken, 'Vodka', junk.toString('base64'));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'not_png' });
    }
  });

  test('a PNG of the wrong dimensions', async () => {
    // The client normalises to 512x512, but the client is not the only caller. A mis-sized
    // image would land on one tile at a different scale to all the others.
    for (const [w, h] of [[256, 256], [512, 640], [1024, 1024]]) {
      const res = await put(adminToken, 'Vodka', png(w, h).toString('base64'));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'bad_size' });
    }
  });

  test('a payload over the route ceiling', async () => {
    const huge = Buffer.concat([png(512, 512), Buffer.alloc(1_100_000)]);
    const res = await put(adminToken, 'Vodka', huge.toString('base64'));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'too_large' });
  });

  test('a payload so large express.json rejects it is still a 413, not a 500', async () => {
    // The body-parser limit fires before any route runs. Reporting that as a server fault
    // both misleads the caller and pages the on-call channel for someone picking a big
    // picture, so the error handler maps it.
    const huge = Buffer.alloc(2_600_000);
    const res = await put(adminToken, 'Vodka', huge.toString('base64'));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'too_large' });
  });

  test('an empty or non-string payload', async () => {
    expect((await put(adminToken, 'Vodka', '')).status).toBe(400);
    expect((await request(app).put('/api/category-images/vodka').set(...auth(adminToken)).send({})).status).toBe(400);
  });

  test('nothing is stored when validation fails', async () => {
    await put(adminToken, 'Vodka', png(64, 64).toString('base64'));
    const { rows } = await db.query('select count(*)::int as n from category_images');
    expect(rows[0].n).toBe(0);
  });
});

describe('permissions', () => {
  test('a cashier cannot upload', async () => {
    expect((await put(cashierToken, 'Whiskey', png(512, 512).toString('base64'))).status).toBe(403);
  });

  test('a cashier cannot delete', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    expect((await request(app).delete('/api/category-images/whiskey').set(...auth(cashierToken))).status).toBe(403);
  });

  test('a cashier CAN read — the sales screen has to draw the tiles', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    expect((await get(cashierToken, 'Whiskey')).status).toBe(200);
    expect((await list(cashierToken)).status).toBe(200);
  });

  test('every route requires a session', async () => {
    expect((await request(app).get('/api/category-images')).status).toBe(401);
    expect((await request(app).get('/api/category-images/whiskey')).status).toBe(401);
    expect((await request(app).put('/api/category-images/whiskey').send({ data: 'x' })).status).toBe(401);
    expect((await request(app).delete('/api/category-images/whiskey')).status).toBe(401);
  });
});

describe('serving', () => {
  test('a category with no upload is a 404, not an empty 200', async () => {
    expect((await get(adminToken, 'nothing-here')).status).toBe(404);
  });

  test('revalidates with an ETag so tiles are not re-downloaded on every render', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    const first = await get(adminToken, 'Whiskey');
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const again = await request(app).get('/api/category-images/whiskey')
      .set(...auth(adminToken)).set('If-None-Match', etag);
    expect(again.status).toBe(304);
  });

  test('the ETag changes when the image is replaced', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    const before = (await get(adminToken, 'Whiskey')).headers.etag;
    await new Promise((r) => setTimeout(r, 5));
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    expect((await get(adminToken, 'Whiskey')).headers.etag).not.toBe(before);
  });

  test('the manifest lists only categories that actually have artwork', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    await put(adminToken, 'Gin', png(512, 512).toString('base64'));
    const rows = (await list(adminToken)).body;
    expect(rows.map((r) => r.cat)).toEqual(['gin', 'whiskey']);
    expect(rows[0].updated_at).toBeTruthy();
  });
});

describe('deleting', () => {
  test('removes the upload so the tile falls back', async () => {
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    expect((await request(app).delete('/api/category-images/whiskey').set(...auth(adminToken))).status).toBe(200);
    expect((await get(adminToken, 'Whiskey')).status).toBe(404);
    expect((await list(adminToken)).body).toEqual([]);
  });

  test('deleting an image the category never had is not an error', async () => {
    expect((await request(app).delete('/api/category-images/ghost').set(...auth(adminToken))).status).toBe(200);
  });

  test('deleting the image does not touch the category itself', async () => {
    // Category deletion is guarded (a category with products cannot be removed); removing
    // its picture is a different, unguarded action and must not be confused with it.
    await request(app).put('/api/settings/categories').set(...auth(adminToken))
      .send({ value: JSON.stringify(['Whiskey']) });
    await put(adminToken, 'Whiskey', png(512, 512).toString('base64'));
    await request(app).delete('/api/category-images/whiskey').set(...auth(adminToken));

    const res = await request(app).get('/api/settings/categories').set(...auth(adminToken));
    expect(JSON.parse(res.body.value)).toEqual(['Whiskey']);
  });
});
