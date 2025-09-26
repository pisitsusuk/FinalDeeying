const { PrismaClient } = require('@prisma/client')

// Singleton pattern to prevent multiple instances
const globalForPrisma = globalThis

// Prisma Client with optimized settings for Supabase Free Plan
const prismaConfig = {
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'], // ลด logging
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
}

// เพิ่ม connection pool settings สำหรับ production (Render + Supabase)
if (process.env.NODE_ENV === 'production') {
  // ใช้ query parameters ใน DATABASE_URL แทน
  // ตัวอย่าง: postgresql://...?connection_limit=3&pool_timeout=10
  console.log('[Prisma] Production mode - using optimized connection settings');
}

const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaConfig)

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// Handle cleanup on process exit
process.on('beforeExit', async () => {
  await prisma.$disconnect()
})

process.on('SIGINT', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

module.exports = prisma
