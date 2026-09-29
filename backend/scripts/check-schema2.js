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

  // Get full column details for SchedulerRecordSummary
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA='aps' AND TABLE_NAME='SchedulerRecordSummary'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('aps.SchedulerRecordSummary full schema:');
  cols.recordset.forEach(c => console.log(' ', c.COLUMN_NAME, c.DATA_TYPE, 'nullable:', c.IS_NULLABLE, 'default:', c.COLUMN_DEFAULT));

  // Check Lynq_VP_BPL_CreateWIBPL params
  const params = await pool.request().query(`
    SELECT PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE
    FROM INFORMATION_SCHEMA.PARAMETERS
    WHERE SPECIFIC_SCHEMA='aps' AND SPECIFIC_NAME='Lynq_VP_BPL_CreateWIBPL'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('\nLynq_VP_BPL_CreateWIBPL params:');
  params.recordset.forEach(p => console.log(' ', p.PARAMETER_NAME, p.DATA_TYPE, p.PARAMETER_MODE));

  await pool.close();
}
main().catch(e => console.error('ERROR:', e.message));
