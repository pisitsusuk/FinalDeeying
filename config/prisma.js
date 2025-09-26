const { PrismaClient } = require('@prisma/client')

// Singleton pattern to prevent multiple instances
const globalForPrisma = globalThis

// Simplified Prisma configuration for Railway
const prismaConfig = {
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
}

// Railway handles connections well, no need for complex pooling
if (process.env.NODE_ENV === 'production') {
  console.log('[Prisma] Production mode - using Railway PostgreSQL');
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
