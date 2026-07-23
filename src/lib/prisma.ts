import { PrismaClient } from "../../prisma/generated/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

let prisma: InstanceType<typeof PrismaClient>;

declare global {
    var __prisma__: InstanceType<typeof PrismaClient>;
}

const adapter = new PrismaMariaDb(process.env.DATABASE_URL!);

if (process.env.NODE_ENV === "production") {
    prisma = new PrismaClient({ adapter });
} else {
    if (!global.__prisma__) {
        global.__prisma__ = new PrismaClient({ adapter });
    }
    prisma = global.__prisma__;
}

export default prisma;
