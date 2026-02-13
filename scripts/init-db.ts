import { Client } from "pg";
import * as dotenv from "dotenv";
import { URL } from "url";

dotenv.config();

async function createDatabase() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not defined in .env");
    process.exit(1);
  }

  try {
    const url = new URL(databaseUrl);
    // Extract database name, ignoring query parameters if any
    const dbName = url.pathname.slice(1);

    // Connect to 'postgres' database to perform administrative tasks
    url.pathname = "/postgres";
    const postgresUrl = url.toString();

    const client = new Client({
      connectionString: postgresUrl,
    });

    await client.connect();
    console.log("Connected to postgres database.");

    // Check if database exists
    const res = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );

    if (res.rowCount === 0) {
      console.log(`Database '${dbName}' does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database '${dbName}' created successfully.`);
    } else {
      console.log(`Database '${dbName}' already exists.`);
    }

    await client.end();
  } catch (err) {
    console.error("Error initializing database:", err);
    process.exit(1);
  }
}

createDatabase();
