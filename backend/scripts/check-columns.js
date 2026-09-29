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

  // Check IMachine column in WipJobAllLab
  const iMachine = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='WipJobAllLab' AND COLUMN_NAME='IMachine'");
  console.log('WipJobAllLab.IMachine exists:', iMachine.recordset.length > 0);

  // Check SchedulerRecordSummary columns
  const srsCols = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='aps' AND TABLE_NAME='SchedulerRecordSummary' ORDER BY ORDINAL_POSITION");
  console.log('aps.SchedulerRecordSummary columns:', srsCols.recordset.map(x => x.COLUMN_NAME));

  // Check SourceProductionOrders columns
  const spoCols = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='aps' AND TABLE_NAME='SourceProductionOrders' ORDER BY ORDINAL_POSITION");
  console.log('aps.SourceProductionOrders columns:', spoCols.recordset.map(x => x.COLUMN_NAME));

  // Check WipJobAllLab all columns
  const allCols = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='WipJobAllLab' ORDER BY ORDINAL_POSITION");
  console.log('WipJobAllLab all columns:', allCols.recordset.map(x => x.COLUMN_NAME));

  await pool.close();
}
main().catch(e => console.error('ERROR:', e.message));
