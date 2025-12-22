// src/lib/auth-service.js

const { PrismaClient } = require("../generated/client");
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

// Kita gunakan satu instance Prisma untuk seluruh aplikasi (Best Practice)
const prisma = new PrismaClient();

/**
 * Fungsi utama untuk menangani autentikasi via Database.
 * @param {string} sessionId - ID unik (contoh: 'user-01', 'toko-a')
 */
const usePrismaAuthState = async (sessionId) => {
  // --- HELPER FUNCTIONS ---
  // Mengubah Buffer (Binary) menjadi JSON String agar bisa masuk DB
  const writeData = (data, key) => {
    try {
      return JSON.stringify(data, BufferJSON.replacer);
    } catch (error) {
      console.error(`Gagal memproses data untuk key ${key}:`, error);
      return null;
    }
  };

  // Mengubah JSON String dari DB kembali menjadi Buffer (Binary)
  const readData = (data) => {
    try {
      return JSON.parse(data, BufferJSON.reviver);
    } catch (error) {
      console.error("Gagal parsing data dari DB:", error);
      return null;
    }
  };

  // --- LOGIC UTAMA ---

  // 1. Cek apakah sesi (Creds) sudah ada di database?
  const credsResult = await prisma.session.findUnique({
    where: {
      sessionId_id: { sessionId: sessionId, id: "creds" },
    },
  });

  // Jika ada, load dari DB. Jika tidak, buat sesi baru.
  const creds = credsResult ? readData(credsResult.data) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        // FUNGSI GET: Baileys minta data spesifik
        get: async (type, ids) => {
          const data = {};

          // Ambil data dari DB berdasarkan sessionId dan list ID
          const result = await prisma.session.findMany({
            where: {
              sessionId: sessionId,
              id: {
                in: ids.map((id) => `${type}-${id}`), // Format key: "sender-key-123"
              },
            },
          });

          // Looping hasil DB dan kembalikan ke format Baileys
          result.forEach((row) => {
            // Hapus prefix tipe ("sender-key-123" jadi "123")
            const keyId = row.id.replace(`${type}-`, "");
            let value = readData(row.data);

            // Khusus tipe 'app-state-sync-key', perlu perlakuan khusus proto
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            data[keyId] = value;
          });

          return data;
        },

        // FUNGSI SET: Baileys mau simpan data baru
        set: async (data) => {
          const tasks = [];

          // Data datang berelompok, kita loop satu per satu
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const dbKey = `${category}-${id}`;
              const stringifiedData = writeData(value, dbKey);

              if (!stringifiedData) continue;

              // Siapkan query Upsert (Update kalau ada, Insert kalau belum)
              tasks.push(
                prisma.session.upsert({
                  where: {
                    sessionId_id: { sessionId: sessionId, id: dbKey },
                  },
                  update: { data: stringifiedData },
                  create: {
                    sessionId: sessionId,
                    id: dbKey,
                    data: stringifiedData,
                  },
                })
              );
            }
          }

          // Jalankan semua query sekaligus biar ngebut (Transaction)
          if (tasks.length > 0) {
            await prisma.$transaction(tasks);
          }
        },
      },
    },
    // FUNGSI SAVE CREDS: Dipanggil saat identitas utama berubah
    saveCreds: async () => {
      const stringifiedCreds = writeData(creds, "creds");
      if (stringifiedCreds) {
        await prisma.session.upsert({
          where: {
            sessionId_id: { sessionId: sessionId, id: "creds" },
          },
          update: { data: stringifiedCreds },
          create: {
            sessionId: sessionId,
            id: "creds",
            data: stringifiedCreds,
          },
        });
      }
    },
  };
};

module.exports = { usePrismaAuthState };
