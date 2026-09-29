require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const sql = require('mssql');
// Connection comes from backend/.env (never hardcode credentials here).
const cfg = {
  server: process.env.SYSPRO_DB_SERVER + (process.env.SYSPRO_DB_INSTANCE ? '\\' + process.env.SYSPRO_DB_INSTANCE : ''),
  database: process.env.SYSPRO_DB_NAME,
  user: process.env.SYSPRO_DB_USER,
  password: process.env.SYSPRO_DB_PASSWORD,
  options: { trustServerCertificate: true, encrypt: false }
};
async function main() {
  const pool = await sql.connect(cfg);

  const tables = await pool.request().query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='aps' ORDER BY TABLE_NAME");
  console.log('aps tables:', tables.recordset.map(x => x.TABLE_NAME));

  const routines = await pool.request().query("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA='aps' ORDER BY ROUTINE_NAME");
  console.log('aps procs/funcs:', routines.recordset.map(x => x.ROUTINE_NAME + ' (' + x.ROUTINE_TYPE + ')'));

  await pool.close();
}
main().catch(e => console.error('ERROR:', e.message));
