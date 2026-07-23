import { PrismaClient, RoleType } from "./generated/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST,
    port: 3306,
    connectionLimit: 5,
    password: process.env.DB_PASSWORD,
    user: process.env.DB_USER,
    database: process.env.MYSQL_DATABASE,
});

const prisma = new PrismaClient({ adapter });

async function main() {
    // Crear roles
    const roles = [
        { name: RoleType.Administrador },
        { name: RoleType.Profesor },
        { name: RoleType.Socio },
    ];

    for (const role of roles) {
        const existingRole = await prisma.role.findUnique({
            where: { name: role.name },
        });

        if (existingRole) {
            console.log(`El rol ${role.name} ya existe.`);
        } else {
            const createdRole = await prisma.role.create({
                data: role,
            });
            console.log(`Rol ${createdRole.name} creado.`);
        }
    }

    console.log("Seed completado");
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error("Error en seed:", e);
        await prisma.$disconnect();
        process.exit(1);
    });
