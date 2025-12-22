// src/auth.js
const express = require("express");
const router = express.Router();
const { PrismaClient } = require("./generated/client");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");

const prisma = new PrismaClient();

// Konfigurasi Email (Ganti dengan SMTP asli nanti)
const transporter = nodemailer.createTransport({
  service: "gmail", // atau host SMTP lain
  auth: {
    user: process.env.SMTP_EMAIL || "email_palsu@gmail.com",
    pass: process.env.SMTP_PASS || "password_palsu",
  },
});

// --- REGISTER ---
router.post("/register", async (req, res) => {
  const { email, password, waSessionId } = req.body;
  try {
    // Cek apakah email atau session ID sudah ada
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: email }, { waSessionId: waSessionId }],
      },
    });

    if (existingUser) {
      return res
        .status(400)
        .json({ error: "Email atau ID Tim sudah digunakan." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        waSessionId,
      },
    });
    res.json({
      status: "success",
      message: "Registrasi berhasil! Silakan login.",
    });
  } catch (e) {
    console.error("Register Error:", e);
    res.status(500).json({ error: "Gagal mendaftar. Coba lagi nanti." });
  }
});

// --- LOGIN ---
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: "User tidak ditemukan." });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Password salah." });

    // Login sukses
    res.json({
      status: "success",
      sessionId: user.waSessionId,
      message: "Login berhasil",
    });
  } catch (e) {
    console.error("Login Error:", e);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// --- FORGOT PASSWORD (REQUEST) ---
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: "Email tidak terdaftar." });

    const token = uuidv4();
    const expiry = new Date(Date.now() + 3600000); // 1 Jam

    await prisma.user.update({
      where: { email },
      data: { resetToken: token, resetTokenExpiry: expiry },
    });

    const resetLink = `${req.protocol}://${req.get(
      "host"
    )}/login.html?reset=${token}`;

    console.log("====================================");
    console.log("LINK RESET PASSWORD (MOCK):");
    console.log(resetLink);
    console.log("====================================");

    // Kembalikan link ke frontend untuk keperluan testing/demo jika SMTP mati
    res.json({
      status: "success",
      message:
        "Link reset telah dibuat (Cek Console atau gunakan link ini untuk testing).",
      debugLink: resetLink,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal memproses permintaan." });
  }
});

// --- RESET PASSWORD (ACTION) ---
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user)
      return res
        .status(400)
        .json({ error: "Token tidak valid atau kadaluarsa." });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    res.json({
      status: "success",
      message: "Password berhasil diubah. Silakan login.",
    });
  } catch (e) {
    res.status(500).json({ error: "Gagal mereset password." });
  }
});

module.exports = router;
