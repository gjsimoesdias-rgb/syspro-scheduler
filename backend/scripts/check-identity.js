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

  // Check if ID is identity
  const identity = await pool.request().query(`
    SELECT c.name, c.is_identity
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'aps' AND t.name = 'SchedulerRecordSummary' AND c.name = 'ID'
  `);
  console.log('SchedulerRecordSummary.ID is_identity:', identity.recordset[0]?.is_identity);

  await pool.close();
}
main().catch(e => console.error('ERROR:', e.message));
