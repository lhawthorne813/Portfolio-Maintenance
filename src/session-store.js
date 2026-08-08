// A tiny SQLite-backed express-session store. Keeping sessions beside the
// application data makes logins survive process restarts without adding Redis.
module.exports = function createSessionStore(session, db) {
  class SQLiteSessionStore extends session.Store {
    get(sid, callback) {
      try {
        const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid=?').get(sid);
        if (!row || row.expire <= Date.now()) {
          if (row) db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
          return callback(null, null);
        }
        callback(null, JSON.parse(row.sess));
      } catch (error) { callback(error); }
    }

    set(sid, value, callback = () => {}) {
      try {
        const expire = value.cookie && value.cookie.expires
          ? new Date(value.cookie.expires).getTime()
          : Date.now() + 14 * 86400000;
        db.prepare(`INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?)
          ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire`)
          .run(sid, JSON.stringify(value), expire);
        callback(null);
      } catch (error) { callback(error); }
    }

    destroy(sid, callback = () => {}) {
      try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); callback(null); }
      catch (error) { callback(error); }
    }

    touch(sid, value, callback = () => {}) {
      try {
        const expire = value.cookie && value.cookie.expires
          ? new Date(value.cookie.expires).getTime()
          : Date.now() + 14 * 86400000;
        db.prepare('UPDATE sessions SET expire=? WHERE sid=?').run(expire, sid);
        callback(null);
      } catch (error) { callback(error); }
    }

    clear(callback = () => {}) {
      try { db.prepare('DELETE FROM sessions').run(); callback(null); }
      catch (error) { callback(error); }
    }

    length(callback) {
      try {
        const row = db.prepare('SELECT COUNT(*) c FROM sessions WHERE expire>?').get(Date.now());
        callback(null, row.c);
      } catch (error) { callback(error); }
    }

    prune() { db.prepare('DELETE FROM sessions WHERE expire<=?').run(Date.now()); }
  }
  return new SQLiteSessionStore();
};
