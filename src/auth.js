// src/auth.js
const express = require("express");
const router = express.Router();
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

// Kita gunakan satu instance Prisma untuk seluruh aplikasi (Best Practice)
console.log("[AUTH-SERVICE] Initializing Prisma Client...");
let prisma;
try {
  const { PrismaClient } = require("./generated/client");
  prisma = new PrismaClient();
  console.log("[AUTH-SERVICE] Prisma Client initialized successfully");
} catch (e) {
  console.error(
    "[AUTH-SERVICE] CRITICAL: Failed to initialize Prisma Client:",
    e.message
  );
  throw e; // Auth service MUST have database, so we throw
}

const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Generate 6-digit verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send verification email using Resend
async function sendVerificationEmail(email, code, type) {
  const subject =
    type === "REGISTER"
      ? "🔐 Kode Verifikasi Pendaftaran NayooAI"
      : "🔑 Kode Reset Password NayooAI";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #6366f1; margin: 0;">NayooAI</h1>
        <p style="color: #666;">WhatsApp Customer Service Bot</p>
      </div>
      
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 16px; text-align: center;">
        <p style="color: #fff; margin: 0 0 20px 0; font-size: 16px;">
          ${
            type === "REGISTER"
              ? "Kode verifikasi pendaftaran Anda:"
              : "Kode reset password Anda:"
          }
        </p>
        <div style="background: #fff; padding: 20px 40px; border-radius: 12px; display: inline-block;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1f2937;">${code}</span>
        </div>
        <p style="color: #e0e0ff; margin: 20px 0 0 0; font-size: 14px;">
          Kode berlaku selama <strong>10 menit</strong>
        </p>
      </div>
      
      <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
        Jika Anda tidak merasa melakukan permintaan ini, abaikan email ini.
      </p>
    </div>
  `;

  try {
    const { data, error } = await resend.emails.send({
      from: "NayooAI <onboarding@resend.dev>",
      to: email,
      subject,
      html,
    });

    if (error) {
      console.error("Resend error:", error);
      return false;
    }

    console.log("Email sent successfully:", data?.id);
    return true;
  } catch (e) {
    console.error("Email send error:", e);
    return false;
  }
}

// --- STEP 1: Request Verification Code for Registration ---
router.post("/register/request-code", async (req, res) => {
  const { email, password, waSessionId } = req.body;

  try {
    // Validate inputs
    if (!email || !password || !waSessionId) {
      return res.status(400).json({ error: "Semua field harus diisi." });
    }

    // Check if email or session ID already exists
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

    // Generate verification code
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete any existing codes for this email
    await prisma.verificationCode.deleteMany({
      where: { email, type: "REGISTER" },
    });

    // Save new code
    await prisma.verificationCode.create({
      data: {
        email,
        code,
        type: "REGISTER",
        expiresAt,
      },
    });

    // Send email
    const emailSent = await sendVerificationEmail(email, code, "REGISTER");

    // For development, also log the code
    console.log("====================================");
    console.log(`VERIFICATION CODE for ${email}: ${code}`);
    console.log("====================================");

    res.json({
      status: "success",
      message: "Kode verifikasi telah dikirim ke email Anda.",
      // Include code in response for development/testing
      debugCode: process.env.NODE_ENV !== "production" ? code : undefined,
    });
  } catch (e) {
    console.error("Register request code error:", e);
    res.status(500).json({ error: "Gagal mengirim kode verifikasi." });
  }
});

// --- STEP 2: Verify Code and Complete Registration ---
router.post("/register/verify", async (req, res) => {
  const { email, password, waSessionId, code } = req.body;

  try {
    // Find valid verification code
    const verification = await prisma.verificationCode.findFirst({
      where: {
        email,
        code,
        type: "REGISTER",
        expiresAt: { gt: new Date() },
        verified: false,
      },
    });

    if (!verification) {
      return res
        .status(400)
        .json({ error: "Kode verifikasi tidak valid atau sudah kadaluarsa." });
    }

    // Check again if user exists (race condition prevention)
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { waSessionId }],
      },
    });

    if (existingUser) {
      return res
        .status(400)
        .json({ error: "Email atau ID Tim sudah digunakan." });
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);

    // Free trial 7 days
    const trialExpiry = new Date();
    trialExpiry.setDate(trialExpiry.getDate() + 7);

    await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        waSessionId,
        role: "USER",
        expiryDate: trialExpiry,
        hideCountdown: false,
      },
    });

    // Mark code as verified and delete it
    await prisma.verificationCode.delete({
      where: { id: verification.id },
    });

    res.json({
      status: "success",
      message: "Registrasi berhasil! Anda mendapat free trial 7 hari.",
    });
  } catch (e) {
    console.error("Register verify error:", e);
    res.status(500).json({ error: "Gagal menyelesaikan registrasi." });
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

    // Check if subscription expired
    let isExpired = false;
    if (user.role === "USER" && user.expiryDate) {
      isExpired = new Date() > new Date(user.expiryDate);
    }

    res.json({
      status: "success",
      sessionId: user.waSessionId,
      role: user.role,
      expiryDate: user.expiryDate,
      hideCountdown: user.hideCountdown,
      isExpired: isExpired,
      message: "Login berhasil",
    });
  } catch (e) {
    console.error("Login Error:", e);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// --- STEP 1: Request Verification Code for Password Reset ---
router.post("/forgot-password/request-code", async (req, res) => {
  const { email } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: "Email tidak terdaftar." });
    }

    // Generate verification code
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete any existing codes for this email
    await prisma.verificationCode.deleteMany({
      where: { email, type: "RESET_PASSWORD" },
    });

    // Save new code
    await prisma.verificationCode.create({
      data: {
        email,
        code,
        type: "RESET_PASSWORD",
        expiresAt,
      },
    });

    // Send email
    const emailSent = await sendVerificationEmail(
      email,
      code,
      "RESET_PASSWORD"
    );

    console.log("====================================");
    console.log(`RESET CODE for ${email}: ${code}`);
    console.log("====================================");

    res.json({
      status: "success",
      message: "Kode verifikasi telah dikirim ke email Anda.",
      debugCode: process.env.NODE_ENV !== "production" ? code : undefined,
    });
  } catch (e) {
    console.error("Forgot password request code error:", e);
    res.status(500).json({ error: "Gagal mengirim kode verifikasi." });
  }
});

// --- STEP 2: Verify Code for Password Reset ---
router.post("/forgot-password/verify-code", async (req, res) => {
  const { email, code } = req.body;

  try {
    const verification = await prisma.verificationCode.findFirst({
      where: {
        email,
        code,
        type: "RESET_PASSWORD",
        expiresAt: { gt: new Date() },
        verified: false,
      },
    });

    if (!verification) {
      return res
        .status(400)
        .json({ error: "Kode verifikasi tidak valid atau sudah kadaluarsa." });
    }

    // Mark as verified (but don't delete, will use for password reset)
    await prisma.verificationCode.update({
      where: { id: verification.id },
      data: { verified: true },
    });

    res.json({
      status: "success",
      message: "Kode terverifikasi. Silakan buat password baru.",
    });
  } catch (e) {
    console.error("Verify reset code error:", e);
    res.status(500).json({ error: "Gagal memverifikasi kode." });
  }
});

// --- STEP 3: Reset Password with Verified Code ---
router.post("/forgot-password/reset", async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    // Check for verified code
    const verification = await prisma.verificationCode.findFirst({
      where: {
        email,
        code,
        type: "RESET_PASSWORD",
        verified: true,
      },
    });

    if (!verification) {
      return res
        .status(400)
        .json({ error: "Kode tidak valid. Silakan minta kode baru." });
    }

    // Update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    // Delete the verification code
    await prisma.verificationCode.delete({
      where: { id: verification.id },
    });

    res.json({
      status: "success",
      message: "Password berhasil diubah. Silakan login.",
    });
  } catch (e) {
    console.error("Reset password error:", e);
    res.status(500).json({ error: "Gagal mereset password." });
  }
});

// Legacy endpoints (keep for backward compatibility)
router.post("/register", async (req, res) => {
  res.status(400).json({
    error:
      "Gunakan endpoint baru: /register/request-code lalu /register/verify",
  });
});

router.post("/forgot-password", async (req, res) => {
  res.status(400).json({
    error: "Gunakan endpoint baru: /forgot-password/request-code",
  });
});

router.post("/reset-password", async (req, res) => {
  res.status(400).json({
    error: "Gunakan endpoint baru: /forgot-password/reset",
  });
});

module.exports = router;
