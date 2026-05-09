import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const url = process.env.DATABASE_URL || "file:./prisma/dev.db";
const adapter = new PrismaLibSql({ url });
const prisma = new PrismaClient({ adapter });

function toUsername(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

async function main() {
  const employees = await prisma.employee.findMany({ where: { username: null } });
  console.log(`Found ${employees.length} employee(s) without a username.`);

  for (const emp of employees) {
    const base = toUsername(emp.name);
    let username = base;
    let i = 1;
    while (true) {
      const existing = await prisma.employee.findFirst({ where: { username } });
      if (!existing || existing.id === emp.id) break;
      username = `${base}${i++}`;
    }
    await prisma.employee.update({ where: { id: emp.id }, data: { username } });
    console.log(`  ${emp.name} → @${username}`);
  }

  console.log("Migration complete!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
