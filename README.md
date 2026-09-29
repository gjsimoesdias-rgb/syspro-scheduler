# 🏭 Syspro Finite Capacity Scheduler

A complete production scheduling solution with direct Syspro database integration, finite capacity planning, and constraint management.

## 🎯 Features

- ✅ **Direct Syspro DB Link**: Reads jobs, workcentres, resources, materials from live Syspro database
- ✅ **Finite Capacity Scheduling**: Respects workcentre and employee availability
- ✅ **Constraint Management**:
  - Overtime limits per workcentre
  - Batch constraints (min/max run quantities)
  - Queue and movement times between operations
  - Setup time dependencies
  - Material availability checks
  - Skill-based resource allocation
- ✅ **Production Mode Selector**: Job-shop, Continuous line (flow-line), or Mixed — controls whether job operations are locked to a single production line (see [docs/production-modes.md](docs/production-modes.md))
- ✅ **Gantt Chart Visualization**: Interactive schedule view with job bars
- ✅ **Resource Allocation**: Resource load analysis and utilization tracking
- ✅ **Constraint Violations Dashboard**: Real-time conflict detection and suggestions
- ✅ **Schedule Export**: Write plans back to Syspro database
- ✅ **RESTful API**: Full API for programmatic access

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│           Frontend (React + TypeScript)     │
│  - Gantt Chart Visualization                │
│  - Resource Allocation Dashboard            │
│  - Constraint Violations Monitor            │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│      Backend API (Express + TypeScript)     │
│  - Schedule Generation Engine               │
│  - Constraint Manager                       │
│  - Syspro Data Service                      │
│  - Export/Write Back Logic                  │
└──────────────────┬──────────────────────────┘
                   │
      ┌────────────┴────────────┐
      ▼                         ▼
  ┌─────────────┐         ┌──────────────┐
  │  Syspro DB  │         │ Scheduler DB │
  │  (Master    │         │  (Persisted  │
  │   Data)     │         │   Plans)     │
  └─────────────┘         └──────────────┘
```

## 📋 Prerequisites

- Windows / SQL Server 2016+
- Node.js 16+ with npm
- Access to local Syspro database
- Syspro database credentials

## 🚀 Getting Started

### 1. Backend Setup

```bash
cd backend
npm install

# Copy environment template and update with your database credentials
cp .env.example .env
# Edit .env with your Syspro and Scheduler database details

# Build
npm run build

# Start development server
npm run dev
```

**Backend .env configuration:**
```env
SYSPRO_DB_SERVER=localhost
SYSPRO_DB_NAME=SYSPRO
SYSPRO_DB_USER=sa
SYSPRO_DB_PASSWORD=yourPassword
SCHEDULER_DB_SERVER=localhost
SCHEDULER_DB_NAME=SCHEDULER
MAX_OVERTIME_HOURS=3.0
HORIZON_DAYS=28
```

### 2. Frontend Setup

```bash
cd frontend
npm install

# Create .env.local for Vite dev server (optional — defaults to localhost:3000 proxy)
# echo "VITE_API_URL=http://localhost:3000/api" > .env.local

# Start Vite development server (hot-reload, proxies /api → backend on :3000)
npm start
```

Frontend dev server runs at `http://localhost:3001` and proxies `/api/*` to the backend.
In production the compiled bundle is served by an nginx container (see `frontend/Dockerfile`)
mapped to `http://localhost:3001` via docker-compose.

### 3. Database Initialization

The scheduler requires a persistence database. Create a SQL Server database:

```sql
CREATE DATABASE SCHEDULER;

-- Create tables for schedule persistence
CREATE TABLE sch_ScheduleVersion (
  scheduleId NVARCHAR(36) PRIMARY KEY,
  scheduledDate DATETIME2,
  version INT,
  status NVARCHAR(50),
  planningHorizonStart DATETIME2,
  planningHorizonEnd DATETIME2,
  createdDate DATETIME2 DEFAULT GETDATE()
);

CREATE TABLE sch_JobSchedule (
  jobScheduleId NVARCHAR(36) PRIMARY KEY,
  scheduleId NVARCHAR(36),
  jobId NVARCHAR(50),
  plannedStartDate DATETIME2,
  plannedEndDate DATETIME2,
  tardinessDays FLOAT,
  status NVARCHAR(50),
  FOREIGN KEY (scheduleId) REFERENCES sch_ScheduleVersion(scheduleId)
);

CREATE TABLE sch_OperationSchedule (
  opScheduleId NVARCHAR(36) PRIMARY KEY,
  jobScheduleId NVARCHAR(36),
  operationId NVARCHAR(50),
  workcentreId NVARCHAR(50),
  resourceId NVARCHAR(50),
  plannedStartDate DATETIME2,
  plannedEndDate DATETIME2,
  isOvertimeSlot BIT,
  durationMinutes INT,
  FOREIGN KEY (jobScheduleId) REFERENCES sch_JobSchedule(jobScheduleId)
);

CREATE TABLE sch_ConstraintViolation (
  violationId NVARCHAR(36) PRIMARY KEY,
  scheduleId NVARCHAR(36),
  violationType NVARCHAR(50),
  severity NVARCHAR(20),
  affectedJobId NVARCHAR(50),
  description NVARCHAR(MAX),
  suggestedAction NVARCHAR(MAX),
  FOREIGN KEY (scheduleId) REFERENCES sch_ScheduleVersion(scheduleId)
);
```

## 📡 API Endpoints

### Schedule Management

- **POST** `/api/schedule/generate` - Generate new schedule
  - Body: `{ planningHorizonStartDate, planningHorizonEndDate }`
  - Returns: Full schedule with jobs, resources, constraints

- **GET** `/api/schedule/:scheduleId` - Get schedule details

- **POST** `/api/schedule/:scheduleId/approve` - Approve schedule for release

- **POST** `/api/schedule/:scheduleId/export-to-syspro` - Export to Syspro database

### Jobs

- **GET** `/api/jobs` - List all open jobs
- **GET** `/api/jobs/:jobId` - Get job details
- **GET** `/api/jobs/:jobId/operations` - Get job operations

### Resources

- **GET** `/api/resources` - List all resources
- **GET** `/api/resources/workcentre/:worcentreId` - Get resources by workcentre
- **GET** `/api/resources/workcentres` - List all workcentres

## 🎮 Usage

### Generating a Schedule

1. Open http://localhost:3001
2. Set Planning Horizon dates (default: today + 28 days)
3. Click "▶️ Generate Schedule"
4. View results in tabs:
   - **📊 Gantt Chart**: Visual timeline of jobs
   - **👥 Resource Allocation**: Load per resource/day
   - **⚠️ Constraints**: Violations and warnings

### Understanding the Results

**Schedule Metrics:**
- **On-Time Jobs**: Jobs meeting due date
- **Tardy Jobs**: Jobs exceeding due date
- **Resource Utilization**: % of available capacity used
- **Overtime Hours**: Total overtime scheduled

**Constraint Violations:**
- 🔴 **Critical**: Material shortage, cannot schedule
- 🟠 **Warnings**: Overtime exceeded, capacity tight
- 🔵 **Info**: Suggestions for optimization

### Exporting to Syspro

1. After schedule generation, click "📤 Export to Syspro"
2. Scheduler updates:
   - `SY_WorkOrderRouting.PlannedStartDate/EndDate`
   - `SY_WorkOrderRouting.ScheduledResourceId`
   - `SY_WorkOrder.ScheduleStartDate/EndDate`
3. All changes logged to `sch_ScheduleChanges` table

## ⚙️ Configuration

### Constraint Settings

Edit `backend/.env` to customize:

```env
# Scheduling horizon (days from today)
HORIZON_DAYS=28

# Max overtime allowed per workcentre per day (hours)
MAX_OVERTIME_HOURS=3.0

# Default timing assumptions (minutes)
SETUP_TIME_MIN=30
QUEUE_TIME_MIN=15
MOVEMENT_TIME_MIN=10

# Batch size constraints
BATCH_MIN_SIZE=1
```

### Scheduling Rules (Edit `backend/src/services/SchedulingEngine.ts`)

Modify priority calculation to change job sequencing:
- `priority` (from Syspro)
- `dueDate` (EDD - Earliest Due Date)
- `criticalRatio` (slack-based)

## 🔍 Syspro Database Integration

### Supported Syspro Tables

| Syspro Table | Usage |
|---|---|
| `SY_WorkOrder` | Production jobs, due dates, priority |
| `SY_WorkOrderRouting` | Operations, sequencing, setup/run times |
| `SY_Worcentre` | Production lines/machines, cost, capacity |
| `SY_Resource` | Employees, equipment, skills, availability |
| `SY_BOMLine` | Material requirements, quantities |
| `SY_Inventory` | Stock levels, available qty, lead times |
| `SY_Calendar` | Holidays, non-working periods |
| `SY_SetupSequence` | Setup time matrix for changeovers |

### Custom Extensions

To add more Syspro entities:

1. Add SQL query to `backend/src/database/queries/sysproDashboard.sql`
2. Add service method to `backend/src/services/SysproDatabaseService.ts`
3. Add model class to `backend/src/models/index.ts`
4. Use in scheduler via context map

## 🧪 Testing the Integration

### Quick Test

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm start

# Terminal 3: Verify Syspro connection
curl http://localhost:3000/api/jobs  # backend API
```

Expected response:
```json
{
  "count": 25,
  "jobs": [
    { "jobId": "WO001", "itemCode": "ITEM-123", "dueDate": "2026-04-15", ... }
  ]
}
```

### Validate Against Syspro

1. Generate schedule
2. Check `sch_ScheduleVersion` table for new entry
3. Verify `sch_OperationSchedule` records
4. Run: `SELECT * FROM sch_ConstraintViolation WHERE severity='Critical'`

## 🐛 Troubleshooting

**"Database not connected" error:**
- Verify SQL Server connection in `.env`
- Check Syspro database is online: `sqlcmd -S <server> -Q "SELECT @@VERSION"`
- Confirm user has SELECT permissions on Syspro tables

**"No jobs scheduled":**
- Verify jobs exist in Syspro: `SELECT * FROM SY_WorkOrder WHERE Status = 'Released'`
- Check planning horizon includes due dates
- Review constraint violations for blocker

**Slow schedule generation:**
- Reduce `HORIZON_DAYS` in `.env`
- Filter jobs by priority in API call
- Increase SQL query timeout

## 📈 Performance Tips

- Schedule generation time: ~5-30s depending on job count
- Use **batching** to group similar items (reduces operations)
- Set **realistic overtime limits** to avoid infeasible schedules
- Run scheduler **off-peak** to minimize Syspro DB load
- Archive old schedules regularly to keep `sch_*` tables lean

## 🔐 Security

- Keep `.env` file private (add to `.gitignore`)
- Use **Windows Authentication** for SQL Server when possible
- Encrypt sensitive fields in `sch_ScheduleVersion`
- Audit all schedule exports via log table
- Restrict API access with authentication middleware (future)

## 🔄 Advanced Features (Roadmap)

- [ ] Multi-site scheduling
- [ ] AI-powered priority optimization
- [ ] Real-time replan on floor disruptions
- [ ] Material procurement integration
- [ ] Maintenance calendar blocking
- [ ] Simulation & what-if analysis
- [ ] Mobile app for floor visibility
- [ ] Predictive bottleneck analysis

## 📚 Documentation

- **Architecture**: [backend/README.md](./backend/README.md)
- **API Reference (OpenAPI)**: [backend/openapi.yaml](./backend/openapi.yaml)
- **Architecture Decisions**: [docs/adr/](./docs/adr/)
- **Engineering Review & Roadmap**: [REVIEW_AND_ROADMAP.md](./REVIEW_AND_ROADMAP.md)
- **Documentation Index**: [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md)

## 📝 License

ISC - Internal use only

## 👨‍💼 Support

For issues or feature requests, contact the development team.

---

**Built with ❤️ for production planning optimization**
