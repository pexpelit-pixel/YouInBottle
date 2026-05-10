export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE",
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

    const badRequest = (message) =>
      json({ success: false, error: message }, { status: 400 });

    const notFound = () =>
      json({ success: false, error: "Not Found" }, { status: 404 });

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

    const toObject = (v, fallback) => {
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
      return fallback;
    };

    const sortedPairKey = (a, b) => {
      return [a, b].map(String).sort().join("|");
    };

    async function getUserPublicKey(userId) {
      if (!userId) return "";
      try {
        const raw = await env.USERS.get(`user:${userId}`);
        if (!raw) return "";
        const user = JSON.parse(raw);
        return safeString(user.publicKey, "");
      } catch {
        return "";
      }
    }

    async function getBottleById(bottleId) {
      const raw = await env.BOTTLES.get(`bottle:${bottleId}`);
      if (!raw) return null;
      try {
        const bottle = JSON.parse(raw);
        if (!bottle.ownerPublicKey && bottle.senderId) {
          bottle.ownerPublicKey = await getUserPublicKey(bottle.senderId);
        }
        return bottle;
      } catch {
        return null;
      }
    }

    async function getConversationById(conversationId) {
      const raw = await env.CONVERSATIONS.get(`conv:${conversationId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    async function refreshConversationLastMessage(conversationId, message) {
      const conv = await getConversationById(conversationId);
      if (!conv) return null;

      conv.lastMessageAt = message.createdAt ?? now();
      conv.updatedAt = now();
      conv.messageCount = (conv.messageCount || 0) + 1;
      conv.lastSenderId = message.senderId;
      conv.lastCiphertext = message.ciphertext;
      conv.lastEncType = message.encType || "RSA-OAEP";

      await env.CONVERSATIONS.put(`conv:${conversationId}`, JSON.stringify(conv));
      return conv;
    }

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
    // -----------------------------
    if (pathname === "/users/register" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const userId = safeString(data.userId);
      if (!userId) return badRequest("userId wajib diisi.");

      const existing = await env.USERS.get(`user:${userId}`);
      const prev = existing ? JSON.parse(existing) : null;

      const user = {
        userId,
        name: safeString(data.name, prev?.name || "Pengunjung") || "Pengunjung",
        avatar: safeString(data.avatar, prev?.avatar || "#ff7e5f") || "#ff7e5f",
        bio: safeString(data.bio, prev?.bio || ""),
        publicKey: safeString(data.publicKey, prev?.publicKey || ""),
        updatedAt: now(),
        createdAt: prev?.createdAt ?? now(),
      };

      await env.USERS.put(`user:${userId}`, JSON.stringify(user));
      return json({ success: true, user });
    }

    // -----------------------------
    // GET USER PROFILE
    // -----------------------------
    if (pathname.startsWith("/users/") && request.method === "GET") {
      const userId = decodeURIComponent(pathname.replace("/users/", ""));
      if (!userId) return badRequest("userId wajib diisi.");

      const raw = await env.USERS.get(`user:${userId}`);
      if (!raw) {
        return json({ success: false, error: "User tidak ditemukan." }, { status: 404 });
      }

      return json({ success: true, user: JSON.parse(raw) });
    }

    // -----------------------------
    // CREATE BOTTLE
    // -----------------------------
    if (pathname === "/bottles" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const senderId = safeString(data.senderId);
      const text = safeString(data.text);

      if (!senderId) return badRequest("senderId wajib diisi.");
      if (!text) return badRequest("text wajib diisi.");

      const bottleId = safeString(data.id) || `bottle_${crypto.randomUUID()}`;

      let ownerPublicKey = safeString(
        data.ownerPublicKey || data.senderPublicKey || data.publicKey,
        ""
      );

      if (!ownerPublicKey) {
        ownerPublicKey = await getUserPublicKey(senderId);
      }

      const bottle = {
        id: bottleId,
        senderId,
        senderName: safeString(data.senderName, "Pengunjung") || "Pengunjung",
        avatar: safeString(data.avatar, "#ff7e5f") || "#ff7e5f",
        text,
        ownerPublicKey,
        position: toObject(data.position, { x: 0, y: 0.1, z: 0 }),
        velocity: toObject(data.velocity, { x: 0, y: 0.2, z: 0 }),
        seed: Number.isFinite(Number(data.seed))
          ? Number(data.seed)
          : Math.floor(Math.random() * 1e9),
        floating: Boolean(data.floating ?? false),
        repliesCount: 0,
        meta: toObject(data.meta, {}),
        createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : now(),
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
    // -----------------------------
    if (pathname === "/bottles" && request.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);

      const list = await env.BOTTLES.list({ prefix: "bottle:" });
      const items = [];

      for (const key of list.keys) {
        const bottle = await getBottleById(key.name.replace("bottle:", ""));
        if (bottle) items.push(bottle);
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
    // -----------------------------
    if (pathname.startsWith("/bottles/") && request.method === "GET") {
      const bottleId = decodeURIComponent(pathname.replace("/bottles/", ""));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const bottle = await getBottleById(bottleId);
      if (!bottle) {
        return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });
      }

      return json({ success: true, bottle });
    }

    // -----------------------------
    // POST REPLY (LEGACY FLOW)
    // masih dipertahankan supaya frontend lama tidak rusak
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

      const bottle = await getBottleById(bottleId);
      if (!bottle) {
        return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });
      }

      const replyId = safeString(data.id) || `reply_${crypto.randomUUID()}`;
      const reply = {
        id: replyId,
        bottleId,
        fromUserId,
        toUserId,
        ciphertext,
        nonce: safeString(data.nonce, ""),
        encType: safeString(data.encType, "RSA-OAEP"),
        createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : now(),
        updatedAt: now(),
      };

      await env.REPLIES.put(`reply:${bottleId}:${replyId}`, JSON.stringify(reply));

      bottle.repliesCount = (bottle.repliesCount || 0) + 1;
      bottle.updatedAt = now();
      await env.BOTTLES.put(`bottle:${bottleId}`, JSON.stringify(bottle));

      return json({ success: true, reply });
    }

    // -----------------------------
    // LIST REPLIES FOR A BOTTLE
    // -----------------------------
    if (pathname === "/replies" && request.method === "GET") {
      const bottleId = safeString(url.searchParams.get("bottleId"));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const toUserId = safeString(url.searchParams.get("toUserId"));
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

    // =============================
    // CONVERSATION SYSTEM
    // =============================

    // Create / get conversation dari bottle
    // Body:
    // {
    //   "bottleId": "bottle_xxx",
    //   "userAId": "uid_sender",
    //   "userBId": "uid_receiver"
    // }
    if (pathname === "/conversations/create" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const bottleId = safeString(data.bottleId);
      const userAId = safeString(data.userAId);
      const userBId = safeString(data.userBId);

      if (!bottleId) return badRequest("bottleId wajib diisi.");
      if (!userAId) return badRequest("userAId wajib diisi.");
      if (!userBId) return badRequest("userBId wajib diisi.");

      const bottle = await getBottleById(bottleId);
      if (!bottle) {
        return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });
      }

      const pairKey = `${bottleId}|${sortedPairKey(userAId, userBId)}`;
      const mapKey = `convmap:${pairKey}`;

      const existingConvId = await env.CONV_MAP?.get(mapKey).catch(() => null);
      if (existingConvId) {
        const existingConv = await getConversationById(existingConvId);
        if (existingConv) {
          return json({ success: true, conversation: existingConv, existed: true });
        }
      }

      const conversationId = `conv_${crypto.randomUUID()}`;
      const conversation = {
        id: conversationId,
        bottleId,
        participants: [userAId, userBId],
        createdAt: now(),
        updatedAt: now(),
        lastMessageAt: null,
        lastSenderId: "",
        lastCiphertext: "",
        lastEncType: "RSA-OAEP",
        messageCount: 0,
      };

      await env.CONVERSATIONS.put(`conv:${conversationId}`, JSON.stringify(conversation));

      // Simpan mapping agar conversation yang sama tidak dobel
      if (env.CONV_MAP) {
        await env.CONV_MAP.put(mapKey, conversationId);
      }

      return json({ success: true, conversation, existed: false });
    }

    // List conversations by userId
    // GET /conversations?userId=xxx
    if (pathname === "/conversations" && request.method === "GET") {
      const userId = safeString(url.searchParams.get("userId"));
      if (!userId) return badRequest("userId wajib diisi.");

      const list = await env.CONVERSATIONS.list({ prefix: "conv:" });
      const items = [];

      for (const key of list.keys) {
        const raw = await env.CONVERSATIONS.get(key.name);
        if (!raw) continue;

        try {
          const conv = JSON.parse(raw);
          if (!Array.isArray(conv.participants)) continue;
          if (!conv.participants.includes(userId)) continue;
          items.push(conv);
        } catch {
          // skip
        }
      }

      items.sort((a, b) => (b.lastMessageAt ?? b.updatedAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.updatedAt ?? a.createdAt ?? 0));

      return json({
        success: true,
        conversations: items,
        count: items.length,
      });
    }

    // Get single conversation
    // GET /conversations/:id
    if (pathname.startsWith("/conversations/") && request.method === "GET") {
      const conversationId = decodeURIComponent(pathname.replace("/conversations/", ""));
      if (!conversationId) return badRequest("conversationId wajib diisi.");

      const conv = await getConversationById(conversationId);
      if (!conv) {
        return json({ success: false, error: "Conversation tidak ditemukan." }, { status: 404 });
      }

      return json({ success: true, conversation: conv });
    }

    // Send encrypted message
    // Body:
    // {
    //   "conversationId": "conv_xxx",
    //   "senderId": "uid_xxx",
    //   "ciphertext": "base64...",
    //   "encType": "RSA-OAEP",
    //   "nonce": "base64..."
    // }
    if (pathname === "/messages" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const conversationId = safeString(data.conversationId);
      const senderId = safeString(data.senderId);
      const ciphertext = safeString(data.ciphertext);

      if (!conversationId) return badRequest("conversationId wajib diisi.");
      if (!senderId) return badRequest("senderId wajib diisi.");
      if (!ciphertext) return badRequest("ciphertext wajib diisi.");

      const conv = await getConversationById(conversationId);
      if (!conv) {
        return json({ success: false, error: "Conversation tidak ditemukan." }, { status: 404 });
      }

      if (!Array.isArray(conv.participants) || !conv.participants.includes(senderId)) {
        return json({ success: false, error: "Sender bukan participant conversation ini." }, { status: 403 });
      }

      const messageId = safeString(data.id) || `msg_${crypto.randomUUID()}`;
      const message = {
        id: messageId,
        conversationId,
        senderId,
        ciphertext,
        nonce: safeString(data.nonce, ""),
        encType: safeString(data.encType, "RSA-OAEP"),
        createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : now(),
        updatedAt: now(),
      };

      await env.MESSAGES.put(`msg:${conversationId}:${messageId}`, JSON.stringify(message));
      await refreshConversationLastMessage(conversationId, message);

      return json({ success: true, message });
    }

    // List messages
    // GET /messages?conversationId=xxx
    if (pathname === "/messages" && request.method === "GET") {
      const conversationId = safeString(url.searchParams.get("conversationId"));
      if (!conversationId) return badRequest("conversationId wajib diisi.");

      const list = await env.MESSAGES.list({ prefix: `msg:${conversationId}:` });
      const messages = [];

      for (const key of list.keys) {
        const raw = await env.MESSAGES.get(key.name);
        if (!raw) continue;

        try {
          messages.push(JSON.parse(raw));
        } catch {
          // skip
        }
      }

      messages.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      return json({
        success: true,
        conversationId,
        messages,
        count: messages.length,
      });
    }

    // Mark conversation read
    // POST /conversations/read
    // Body: { "conversationId": "...", "userId": "..." }
    if (pathname === "/conversations/read" && request.method === "POST") {
      const data = await readJson();
      if (!data) return badRequest("JSON tidak valid.");

      const conversationId = safeString(data.conversationId);
      const userId = safeString(data.userId);

      if (!conversationId) return badRequest("conversationId wajib diisi.");
      if (!userId) return badRequest("userId wajib diisi.");

      const conv = await getConversationById(conversationId);
      if (!conv) {
        return json({ success: false, error: "Conversation tidak ditemukan." }, { status: 404 });
      }

      conv.updatedAt = now();
      conv.lastReadAt = conv.lastReadAt || {};
      conv.lastReadAt[userId] = now();

      await env.CONVERSATIONS.put(`conv:${conversationId}`, JSON.stringify(conv));

      return json({ success: true, conversation: conv });
    }

    // -----------------------------
    // DELETE BOTTLE
    // -----------------------------
    if (pathname.startsWith("/bottles/") && request.method === "DELETE") {
      const bottleId = decodeURIComponent(pathname.replace("/bottles/", ""));
      if (!bottleId) return badRequest("bottleId wajib diisi.");

      const raw = await env.BOTTLES.get(`bottle:${bottleId}`);
      if (!raw) {
        return json({ success: false, error: "Botol tidak ditemukan." }, { status: 404 });
      }

      await env.BOTTLES.delete(`bottle:${bottleId}`);

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
