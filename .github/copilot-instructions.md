# Syspro Scheduler Development Instructions

This workspace contains a full-stack production scheduling application integrating directly with Syspro databases.

## Project Structure

```
syspro-scheduler/
├── backend/                    # Express API server (TypeScript)
│   ├── src/
│   │   ├── api/routes/        # REST endpoints
│   │   ├── services/          # Business logic (Scheduler, Constraint Manager)
│   │   ├── models/            # Data models
│   │   ├── database/          # SQL queries, connection
│   │   ├── utils/             # Helpers (calendar, validation)
│   │   └── config/            # Configuration files
│   ├── package.json
│   └── tsconfig.json
├── frontend/                   # React UI (TypeScript)
│   ├── src/
│   │   ├── components/        # React components (Gantt, Resource chart, Constraints)
│   │   ├── services/          # API client
│   │   └── App.tsx           # Main app
│   └── package.json
├── shared/                     # Shared types and constants
│   ├── types.ts              # TypeScript interfaces
│   └── constants.ts           # Constants
└── README.md                  # Main documentation
```

## Architecture Overview

**Frontend (React):**
- Gantt chart visualization
- Resource allocation dashboard
- Constraint violation monitor
- Schedule management UI

**Backend (Express + TypeScript):**
- REST API for schedule generation/retrieval
- Syspro database integration (direct SQL)
- Finite capacity scheduling engine
- Constraint manager
- Export/write-back to Syspro

**Databases:**
- Syspro: Master data (jobs, resources, materials)
- Scheduler DB: Persistent schedule storage

## Key Technologies

- Backend: Node.js, Express, TypeScript, MSSQL
- Frontend: React 18, TypeScript, React Router, Zustand
- Database: SQL Server, direct JDBC/ODBC connection
- Scheduling Algorithm: Greedy with priority-based job sequencing

## Development Workflow

### Backend Development

1. Add new constraint type:
   - Define method in `ConstraintManager`
   - Integrate into `SchedulingEngine.findBestOperationSlot()`
   - Record violations

2. Add Syspro data source:
   - Add SQL query to `queries/sysproDashboard.sql`
   - Add service method to `SysproDatabaseService`
   - Use in scheduler context

3. Add API endpoint:
   - Create route handler in `api/routes/`
   - Export from `app.ts`
   - Document in main README

### Frontend Development

1. Add visualization component:
   - Create in `components/`
   - Import in `App.tsx`
   - Add tab in tab-bar

2. Call API:
   - Use `services/api.ts` for HTTP calls
   - Handle loading/error states
   - Show results with toast notifications

3. Styling:
   - Use intrinsic CSS (not styled-components)
   - Color palette: Blues (#667eea), greens (#10b981), reds (#ef4444)
   - Mobile-responsive with flexbox

## Running the Application

### Development Mode

```bash
# Terminal 1: Backend
cd backend
npm install
cp .env.example .env
# Edit .env with your database credentials
npm run dev

# Terminal 2: Frontend
cd frontend
npm install
npm start
```

Backend runs on `http://localhost:3000`
Frontend runs on `http://localhost:3001` (or 3000 in production)

### Production (Docker)

```bash
docker-compose up -d
```

## Database Setup

1. Create scheduler database:
```sql
CREATE DATABASE SCHEDULER;
```

2. Execute schema setup (see main README)

3. Update authentication in `.env`

## API Reference

See `backend/README.md` for detailed API documentation.

## Constraint Types Supported

- **Overtime**: Max hours/day per workcentre
- **Batching**: Min/max run quantities
- **Setup Time**: Sequence-dependent changeover times
- **Queue Time**: Time between operations
- **Movement Time**: Time to move job between workcentres
- **Material**: Check inventory availability
- **Skill**: Match operator skills to operations

## Extending the Scheduler

### Add New Constraint

Edit `backend/src/services/ConstraintManager.ts`:
```typescript
checkNewConstraint(op, resource, job): boolean {
  // Evaluation logic
  return isValid;
}
```

Then integrate into `SchedulingEngine`:
```typescript
if (!constraintManager.checkNewConstraint(...)) {
  // Reject slot
}
```

### Add New Syspro Entity

1. SQL query in `backend/src/database/queries/sysproDashboard.sql`
2. Service method in `backend/src/services/SysproDatabaseService.ts`
3. Model class in `backend/src/models/index.ts`
4. Pass via scheduling context

## Code Style

- **TypeScript**: Strict mode enabled
- **Naming**: camelCase for functions/variables, PascalCase for classes/interfaces
- **Components**: Functional React components with hooks
- **Errors**: Use try/catch with proper logging

## Testing

Currently no automated tests. To add:
1. Install Jest: `npm install jest @types/jest`
2. Create `*.test.ts` files alongside source
3. Run: `npm test`

## Debugging

- Backend: `NODE_DEBUG=mssql npm run dev` for SQL debug
- Frontend: Use React DevTools browser extension
- Logs: Check console output and `/tmp/scheduler-*.log`

## Performance Optimization

- Index Syspro queries on `Status`, `DueDate`, `WorkOrderId`
- Reduce `HORIZON_DAYS` for faster generation
- Add caching for calendar data
- Use pagination for large result sets

## Common Issues

**"No jobs scheduled":**
- Check Syspro jobs with `SELECT * FROM SY_WorkOrder WHERE Status = 'Released'`
- Verify planning horizon includes due dates
- Review constraint violations

**"Database connection failed":**
- Verify `.env` SQL credentials
- Check SQL Server is running
- Ensure user has SELECT permissions

**"Slow schedule generation":**
- Reduce planning horizon
- Filter by job priority
- Add SQL indexes

## Deployment Checklist

- [ ] Update database connection strings
- [ ] Set `NODE_ENV=production`
- [ ] Build frontend static bundle
- [ ] Test API endpoints
- [ ] Verify Syspro database access
- [ ] Set up logging and monitoring
- [ ] Configure backups for scheduler DB
- [ ] Run initial test schedule

## Documentation

- **Main**: [README.md](./README.md)
- **Backend**: [backend/README.md](./backend/README.md)
- **API Detail**: Contact development team
- **Syspro Schema**: Contact Syspro administrator

## Contacts

- Architecture: AI Development Team
- Syspro Admin: [Contact]
- Database Admin: [Contact]
