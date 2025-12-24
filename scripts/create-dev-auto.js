// scripts/create-dev-auto.js
// Script otomatis untuk membuat akun developer tanpa interaksi
// Usage: node scripts/create-dev-auto.js <email> <password> <sessionId>
// Example: node scripts/create-dev-auto.js admin@nayoo.id admin123 dev_admin

const { PrismaClient } = require("../src/generated/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log("========================================");
    console.log("  CREATE DEVELOPER ACCOUNT - NayooAI");
    console.log("========================================\n");
    console.log("Usage: node scripts/create-dev-auto.js <email> <password> <sessionId>");
    console.log("Example: node scripts/create-dev-auto.js admin@nayoo.id admin123 dev_admin");
    process.exit(1);
  }

  const [email, password, waSessionId] = args;

  console.log("========================================");
  console.log("  CREATE DEVELOPER ACCOUNT - NayooAI");
  console.log("========================================\n");

  try {
    // Cek apakah email atau session ID sudah ada
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
      console.log(`✅ User sudah ada, role diupgrade ke DEVELOPER!`);
      console.log(`   Email: ${existing.email}`);
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
      console.log("✅ Developer account berhasil dibuat!");
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
  }
}

main();
