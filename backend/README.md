# Backend - Syspro Scheduler API

Production scheduling engine with direct Syspro database integration.

## Architecture

```
Express Server
  ├── /schedule routes
  │   ├── POST /generate     - Schedule generation
  │   ├── POST /approve      - Approve schedule
  │   ├── POST /export       - Export to Syspro
  │   └── GET  /:id          - Fetch schedule
  ├── /jobs routes
  │   ├── GET  /             - List jobs
  │   ├── GET  /:id          - Job details
  │   └── GET  /:id/ops      - Operations
  └── /resources routes
      ├── GET  /             - List resources
      └── GET  /workcentres  - List workcentres

Services
  ├── SysproDatabaseService   - Read from Syspro
  ├── SchedulingEngine        - Core finite capacity scheduler
  ├── ConstraintManager       - Constraint evaluation
  └── DatabaseConnection      - SQL Server abstraction

Models
  ├── JobModel
  ├── OperationModel
  ├── WorkcentreModel
  ├── ResourceModel
  └── CalendarModel
```

## Key Services

### SchedulingEngine

Implements finite capacity scheduling using:
- **Priority-based job sequencing** (Shortest Slack, EDD)
- **Greedy operation placement** with backtracking
- **Constraint satisfaction** (capacity, setup, material)
- **Overtime and shift management**

Algorithm flow:
1. Sort jobs by priority
2. For each job:
   - Process operations in sequence
   - Find first available resource+workcentre slot
   - Consider overtime constraints
   - Apply setup/queue/movement times
   - Create operation schedule
3. Calculate metrics and constraint violations

### ConstraintManager

Enforces:
- **Overtime limits** per workcentre per day
- **Batching rules** (min/max quantities)
- **Setup sequence dependencies** (changeover times)
- **Movement times** between workcentres
- **Queue times** between operations
- **Resource availability** windows

### SysproDatabaseService

Transforms Syspro data:
```
SY_WorkOrder            → Job
SY_WorkOrderRouting     → Operation
SY_Worcentre            → Workcentre
SY_Resource             → Resource
SY_BOMLine              → BOM
SY_Inventory            → Material
SY_Calendar/Shift       → Calendar
SY_SetupSequence        → Setup Matrix
```

## Extending the Scheduler

### Add a New Constraint Type

1. **Define in ConstraintManager:**
```typescript
canScheduleWithNewConstraint(operation, slot): boolean {
  // Evaluate constraint
  return isValid;
}
```

2. **Integrate into SchedulingEngine.findBestOperationSlot():**
```typescript
if (!constraintManager.canScheduleWithNewConstraint(op, slot)) {
  // Skip this slot
}
```

3. **Record violations:**
```typescript
this.constraints.push({
  violationId: uuid(),
  type: 'NewConstraint',
  severity: 'Warning',
  affectedJobId: job.jobId,
  description: 'Constraint violated'
});
```

### Add a New Data Source

1. **Add query to `queries/sysproDashboard.sql`**
2. **Add method to `SysproDatabaseService`:**
```typescript
async getNewEntity(): Promise<NewEntity[]> {
  const result = await this.sysproDb.query(SYSPRO_QUERIES.newQuery);
  return result.recordset.map(row => new NewEntityModel(...));
}
```
3. **Use in scheduler:**
```typescript
const entities = await sysproService.getNewEntity();
context.entityMap = new Map(entities.map(e => [e.id, e]));
```

### Performance Tuning

Slow schedules? Try:

1. **Index Syspro queries** - Add SQL indexes on:
   - `SY_WorkOrder(Status, DueDate)`
   - `SY_WorkOrderRouting(WorkOrderId, Sequence)`

2. **Limit job search scope** - Use API filter:
```json
{ "jobFilter": { "priorities": [1,2,3], "dueDateBefore": "2026-05-01" } }
```

3. **Reduce lookahead** - Set shorter `HORIZON_DAYS`

4. **Cache calendar data** - Pre-compute working days

## Deployment

### Docker
```bash
docker build -t scheduler-backend .
docker run -p 3000:3000 \
  -e SYSPRO_DB_SERVER=mssql \
  -e SYSPRO_DB_USER=sa \
  scheduler-backend
```

### PM2 (Production)
```bash
npm install -g pm2
npm run build
pm2 start "node dist/server.js" --name "scheduler" --env production
pm2 save
```

## Monitoring

Health check:
```bash
curl http://localhost:3000/health
```

Response:
```json
{ "status": "OK", "uptime": 3600.5 }
```

## Debugging

Enable verbose logging:
```bash
NODE_ENV=development npm run dev
```

Check database connection:
```bash
# In node REPL
const { sysproDb } = require('./dist/server');
await sysproDb.query('SELECT TOP 1 * FROM SY_WorkOrder');
```

## Performance Baseline

*Measured on: Intel i7, 16GB RAM, SQL Server 2019*

| Metric | Value |
|--------|-------|
| Jobs to schedule | 50 |
| Schedule generation | ~8 seconds |
| Schedule export to Syspro | ~2 seconds |
| API response time (avg) | 150ms |
| Memory usage | ~80MB |
| CPU peak | ~35% |

---

For full documentation, see main [README.md](../README.md)
