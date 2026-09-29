require('dotenv').config();
const sql = require('mssql');
const config = {
  server: process.env.SCHEDULER_DB_SERVER,
  database: process.env.SCHEDULER_DB_NAME,
  options: {
    instanceName: process.env.SCHEDULER_DB_INSTANCE,
    trustServerCertificate: true,
    encrypt: false
  },
  authentication: {
    type: 'default',
    options: { userName: process.env.SCHEDULER_DB_USER, password: process.env.SCHEDULER_DB_PASSWORD }
  }
};
async function main() {
  const pool = await sql.connect(config);
  const tables = await pool.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE 'lic%' OR TABLE_NAME LIKE 'sch%' ORDER BY TABLE_NAME"
  );
  console.log('Tables:', tables.recordset.map(r => r.TABLE_NAME));
  
  try {
    const users = await pool.request().query('SELECT username, role, is_active FROM dbo.lic_users');
    console.log('Users:', users.recordset);
  } catch (e) {
    console.log('lic_users error:', e.message);
  }

  try {
    const migs = await pool.request().query('SELECT name FROM dbo.sch_Migrations ORDER BY name');
    console.log('Applied migrations:', migs.recordset.map(r => r.name));
  } catch (e) {
    console.log('sch_Migrations error:', e.message);
  }

  await pool.close();
}
main().catch(console.error);
