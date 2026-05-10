// worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, init = {}) =>
      new Response(JSON.stringify(data, null, 2), {
        ...init,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders,
          ...(init.headers || {}),
        },
      });

    const badRequest = (message) => json({ success: false, error: message }, { status: 400 });
    const notFound = () => json({ success: false, error: "Not Found" }, { status: 404 });

    const readJson = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    const now = () => Date.now();

    const clampInt = (value, min, max, fallback) => {
      const n = Number.parseInt(String(value ?? ""), 10);
      if (Number.isNaN(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };

    const safeString = (v, fallback = "") => {
      if (typeof v !== "string") return fallback;
      return v.trim();
    };

    // -----------------------------
    // HEALTH CHECK
    // -----------------------------
    if (pathname === "/health" && request.method === "GET") {
      return json({
        success: true,
        service: "pulau-cinta-worker",
        time: now(),
      });
    }

    // -----------------------------
    // REGISTER / UPDATE USER
    // Body:
    // {
    //   "userId": "uid_123",
    //   "name": "Genta",
    //   "avatar": "#ff7e5f",
    //   "bio": "....",
    //   "publicKey": "base64_or_jwk_string"
    // }
    // -----------------------------
    if (pathname === "/users/register" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const userId = safeString(data.userId);
      if (!userId) return badRequest("userId wajib diisi.");

      const user = {
        userId,
        name: safeString(data.name, "Pengunjung") || "Pengunjung",
        avatar: safeString(data.avatar, "#ff7e5f") || "#ff7e5f",
        bio: safeString(data.bio, ""),
        publicKey: safeString(data.publicKey, ""),
        updatedAt: now(),
        createdAt: now(),
      };

      const existing = await env.USERS.get(`user:${userId}`);
      if (existing) {
        const prev = JSON.parse(existing);
        user.createdAt = prev.createdAt ?? user.createdAt;
      }

      await env.USERS.put(`user:${userId}`, JSON.stringify(user));
      return json({ success: true, user });
    }

    // -----------------------------
    // GET USER PROFILE
    // GET /users/:userId
    // -----------------------------
    if (pathname.startsWith("/users/") && request.method === "GET") {
      const userId = decodeURIComponent(pathname.replace("/users/", ""));
      if (!userId) return badRequest("userId wajib diisi.");

      const raw = await env.USERS.get(`user:${userId}`);
      if (!raw) return json({ success: false, error: "User tidak ditemukan." }, { status: 404 });

      return json({ success: true, user: JSON.parse(raw) });
    }

    // -----------------------------
    // CREATE BOTTLE
    // Body:
    // {
    //   "id": "bottle_xxx",
    //   "senderId": "uid_123",
    //   "senderName": "Genta",
    //   "avatar": "#ff7e5f",
    //   "text": "Halo laut",
    //   "position": { "x": 1, "y": 0.1, "z": -3 },
    //   "meta": { ...optional }
    // }
    // -----------------------------
    if (pathname === "/bottles" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const senderId = safeString(data.senderId);
      const text = safeString(data.text);

      if (!senderId) return badRequest("senderId wajib diisi.");
      if (!text) return badRequest("text wajib diisi.");

      const bottleId = safeString(data.id) || `bottle_${crypto.randomUUID()}`;
      const bottle = {
        id: bottleId,
        senderId,
        senderName: safeString(data.senderName, "Pengunjung") || "Pengunjung",
        avatar: safeString(data.avatar, "#ff7e5f") || "#ff7e5f",
        text,
        position: data.position && typeof data.position === "object" ? data.position : { x: 0, y: 0.1, z: 0 },
        floating: Boolean(data.floating ?? false),
        repliesCount: 0,
        meta: data.meta && typeof data.meta === "object" ? data.meta : {},
        createdAt: now(),
        updatedAt: now(),
      };

      await env.BOTTLES.put(`bottle:${bottleId}`, JSON.stringify(bottle));

      return json({
        success: true,
        bottle,
      });
    }

    // -----------------------------
    // LIST BOTTLES
    // GET /bottles?limit=50
    // -----------------------------
    if (pathname === "/bottles" && request.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);

      const list = await env.BOTTLES.list({ prefix: "bottle:" });
      const items = [];

      for (const key of list.keys) {
        const raw = await env.BOTTLES.get(key.name);
        if (!raw) continue;
        try {
          items.push(JSON.parse(raw));
        } catch {
          // skip bad JSON
        }
      }

      items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

      return json({
        success: true,
        bottles: items.slice(0, limit),
        count: Math.min(items.length, limit),
      });
    }

    // -----------------------------
    // GET SINGLE BOTTLE
    // GET /bottles/:id
    // -----------------------------
    if (pathname.startsWith("/bottles/") && request.method === "GET") {
      const bottleId = decodeURIComponent(pathname.replace("/bottles/", ""));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const raw = await env.BOTTLES.get(`bottle:${bottleId}`);
      if (!raw) return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });

      return json({ success: true, bottle: JSON.parse(raw) });
    }

    // -----------------------------
    // POST REPLY (E2E CIPHERTEXT)
    // Body:
    // {
    //   "id": "reply_xxx",
    //   "bottleId": "bottle_123",
    //   "fromUserId": "uid_a",
    //   "toUserId": "uid_b",
    //   "ciphertext": "base64...",
    //   "encType": "AES-GCM",
    //   "nonce": "base64...",
    //   "createdAt": 123
    // }
    //
    // Worker TIDAK membaca isi reply.
    // Simpan ciphertext apa adanya.
    // -----------------------------
    if (pathname === "/replies" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const bottleId = safeString(data.bottleId);
      const fromUserId = safeString(data.fromUserId);
      const toUserId = safeString(data.toUserId);
      const ciphertext = safeString(data.ciphertext);

      if (!bottleId) return badRequest("bottleId wajib diisi.");
      if (!fromUserId) return badRequest("fromUserId wajib diisi.");
      if (!toUserId) return badRequest("toUserId wajib diisi.");
      if (!ciphertext) return badRequest("ciphertext wajib diisi.");

      const bottleRaw = await env.BOTTLES.get(`bottle:${bottleId}`);
      if (!bottleRaw) return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });

      const replyId = safeString(data.id) || `reply_${crypto.randomUUID()}`;
      const reply = {
        id: replyId,
        bottleId,
        fromUserId,
        toUserId,
        ciphertext,
        nonce: safeString(data.nonce, ""),
        encType: safeString(data.encType, "AES-GCM"),
        createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : now(),
        updatedAt: now(),
      };

      await env.REPLIES.put(`reply:${bottleId}:${replyId}`, JSON.stringify(reply));

      const bottle = JSON.parse(bottleRaw);
      bottle.repliesCount = (bottle.repliesCount || 0) + 1;
      bottle.updatedAt = now();
      await env.BOTTLES.put(`bottle:${bottleId}`, JSON.stringify(bottle));

      return json({ success: true, reply });
    }

    // -----------------------------
    // LIST REPLIES FOR A BOTTLE
    // GET /replies?bottleId=xxx&toUserId=yyy
    // Note: server tetap tidak bisa decrypt.
    // -----------------------------
    if (pathname === "/replies" && request.method === "GET") {
      const bottleId = safeString(url.searchParams.get("bottleId"));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const toUserId = safeString(url.searchParams.get("toUserId")); // optional, buat filter di client
      const list = await env.REPLIES.list({ prefix: `reply:${bottleId}:` });

      const replies = [];
      for (const key of list.keys) {
        const raw = await env.REPLIES.get(key.name);
        if (!raw) continue;
        try {
          const reply = JSON.parse(raw);
          if (toUserId && reply.toUserId !== toUserId) continue;
          replies.push(reply);
        } catch {
          // skip bad JSON
        }
      }

      replies.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      return json({
        success: true,
        bottleId,
        replies,
        count: replies.length,
      });
    }

    // -----------------------------
    // DELETE BOTTLE (opsional)
    // DELETE /bottles/:id
    // -----------------------------
    if (pathname.startsWith("/bottles/") && request.method === "DELETE") {
      const bottleId = decodeURIComponent(pathname.replace("/bottles/", ""));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const raw = await env.BOTTLES.get(`bottle:${bottleId}`);
      if (!raw) return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });

      // hapus botol
      await env.BOTTLES.delete(`bottle:${bottleId}`);

      // hapus semua reply yang terkait
      const replies = await env.REPLIES.list({ prefix: `reply:${bottleId}:` });
      for (const key of replies.keys) {
        await env.REPLIES.delete(key.name);
      }

      return json({
        success: true,
        deletedBottleId: bottleId,
        deletedReplies: replies.keys.length,
      });
    }

    return notFound();
  },
};
