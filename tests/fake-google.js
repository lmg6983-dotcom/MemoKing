// 시험용 가짜 Google Calendar API — 단위 시험 · PC 통합 시험 · 휴대폰 미리보기 서버(android/web/dev/server.mjs)가 함께 쓴다
/** 가짜 Google Calendar API (calendars · events, syncToken, 지운 일정은 cancelled 로 남음) */
export class FakeGoogle {
  /** @param {{ realTime?: boolean }} [o] realTime: 고친 때를 지금 시각으로 (미리보기 서버) */
  constructor({ realTime = false } = {}) {
    this.realTime = realTime;
    this.calendars = new Map();
    this.events = new Map(); // id → event
    this.clock = 1;
    this.calls = [];
  }
  tick() {
    this.clock++;
    return this.realTime ? new Date().toISOString() : new Date(Date.UTC(2026, 9, 16, 0, 0, this.clock)).toISOString();
  }
  // 사용자가 Google 캘린더(삼성 캘린더)에서 직접 고치기
  edit(id, change) {
    Object.assign(this.events.get(id), change, { updated: this.tick(), seq: this.clock });
  }
  create(ev) {
    const id = `g${this.clock}x`;
    this.events.set(id, { ...ev, id, status: 'confirmed', updated: this.tick(), seq: this.clock });
    return id;
  }
  async request(method, url, body) {
    const u = new URL(url);
    const path = u.pathname.replace('/calendar/v3', '');
    this.calls.push(`${method} ${path}`);
    const json = (status, j = {}) => ({ status, json: j });
    if (method === 'POST' && path === '/calendars') {
      const id = `cal${this.calendars.size + 1}@group.calendar.google.com`;
      this.calendars.set(id, body);
      return json(200, { id });
    }
    const m = /^\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return json(404);
    const calId = decodeURIComponent(m[1]);
    if (!this.calendars.has(calId)) return json(404);
    const evId = m[2] ? decodeURIComponent(m[2]) : null;
    if (!path.includes('/events')) return json(200, { id: calId });
    if (method === 'GET') {
      const token = Number(u.searchParams.get('syncToken') ?? 0);
      const items = [...this.events.values()].filter((e) => e.seq > token && (token || e.status !== 'cancelled'));
      return json(200, { items: structuredClone(items), nextSyncToken: String(this.clock) });
    }
    if (method === 'POST') {
      if (this.events.has(body.id)) return json(409);
      this.events.set(body.id, { ...structuredClone(body), updated: this.tick(), seq: this.clock });
      return json(200, this.events.get(body.id));
    }
    if (!this.events.has(evId)) return json(404);
    if (method === 'PUT') {
      this.events.set(evId, { ...structuredClone(body), id: evId, updated: this.tick(), seq: this.clock });
      return json(200, this.events.get(evId));
    }
    if (method === 'PATCH') {
      this.edit(evId, structuredClone(body));
      return json(200, this.events.get(evId));
    }
    if (method === 'DELETE') {
      this.edit(evId, { status: 'cancelled' });
      return json(204);
    }
    return json(400);
  }
}

