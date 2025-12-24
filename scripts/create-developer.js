// scripts/create-developer.js
// Script untuk membuat akun developer pertama

const { PrismaClient } = require("../src/generated/client");
const bcrypt = require("bcryptjs");
const readline = require("readline");

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  console.log("========================================");
  console.log("  CREATE DEVELOPER ACCOUNT - NayooAI");
  console.log("========================================\n");

  const email = await ask("Email Developer: ");
  const password = await ask("Password: ");
  const waSessionId = await ask("Session ID (misal: dev_admin): ");

  try {
    // Cek apakah email sudah ada
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: email }, { waSessionId: waSessionId }],
      },
    });

    if (existing) {
      // Update role to developer
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          role: "DEVELOPER",
          expiryDate: null, // Unlimited
        },
      });
      console.log("\n✅ User sudah ada, role diupgrade ke DEVELOPER!");
    } else {
      // Create new developer
      const hashedPassword = await bcrypt.hash(password, 10);
      await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          waSessionId,
          role: "DEVELOPER",
          expiryDate: null, // Unlimited
          hideCountdown: false,
        },
      });
      console.log("\n✅ Developer account berhasil dibuat!");
    }

    console.log("\n========================================");
    console.log("Login ke /login.html dengan:");
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log("========================================\n");
  } catch (e) {
    console.error("❌ Error:", e.message);
  } finally {
    await prisma.$disconnect();
    rl.close();
  }
}

main();
