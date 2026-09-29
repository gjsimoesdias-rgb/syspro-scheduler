require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const sql = require('mssql');
// Connection comes from backend/.env (never hardcode credentials here).
const config = {
  server: process.env.SYSPRO_DB_SERVER + (process.env.SYSPRO_DB_INSTANCE ? '\\' + process.env.SYSPRO_DB_INSTANCE : ''),
  database: process.env.SYSPRO_DB_NAME,
  user: process.env.SYSPRO_DB_USER,
  password: process.env.SYSPRO_DB_PASSWORD,
  options: { trustServerCertificate: true, encrypt: false }
};
async function main() {
  const pool = await sql.connect(config);

  const schemas = await pool.request().query("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'aps'");
  console.log('APS schema exists:', schemas.recordset.length > 0);

  const wipCols = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'WipMaster' AND COLUMN_NAME LIKE '%Sch%' ORDER BY COLUMN_NAME");
  console.log('WipMaster Sch* columns:', wipCols.recordset.map(r => r.COLUMN_NAME));

  const labCols = await pool.request().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'WipJobAllLab' AND COLUMN_NAME LIKE '%Sch%' ORDER BY COLUMN_NAME");
  console.log('WipJobAllLab Sch* columns:', labCols.recordset.map(r => r.COLUMN_NAME));

  // Check WipMaster exists
  const wipExists = await pool.request().query("SELECT TOP 1 Job FROM WipMaster");
  console.log('WipMaster has rows:', wipExists.recordset.length > 0, '- Sample job:', wipExists.recordset[0]?.Job);

  // Check WipJobAllLab exists
  const labExists = await pool.request().query("SELECT TOP 1 Job FROM WipJobAllLab");
  console.log('WipJobAllLab has rows:', labExists.recordset.length > 0, '- Sample job:', labExists.recordset[0]?.Job);

  await pool.close();
}
main().catch(e => console.error('ERROR:', e.message));
