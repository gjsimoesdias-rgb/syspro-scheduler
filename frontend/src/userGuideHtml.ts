export type GuideSection = 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts';

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const getUserGuideHtml = (focus: GuideSection = 'overview'): string => {
  const section = escapeHtml(focus);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ascend APS - User Guide</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --ink: #16324f;
      --muted: #4d6683;
      --line: #d7e3f0;
      --brand: #486ddc;
      --brand2: #6fa4ff;
      --ok: #0f9d58;
      --warn: #d97706;
      --bad: #d93025;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: Segoe UI, Arial, sans-serif;
      background: linear-gradient(180deg, #edf4ff 0%, var(--bg) 100%);
      color: var(--ink);
      line-height: 1.55;
    }
    .hero {
      background: linear-gradient(135deg, var(--brand) 0%, #324ea8 45%, #22376f 100%);
      color: white;
      padding: 28px 32px;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 30px;
    }
    .hero p {
      margin: 0;
      max-width: 1000px;
      color: rgba(255,255,255,0.92);
      font-size: 15px;
    }
    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .search-bar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 14px 18px;
      margin: 0 18px;
      margin-top: 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(32, 66, 115, 0.08);
    }
    .search-bar input {
      flex: 1;
      min-width: 180px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #c7d8ef;
      font-size: 14px;
      outline: none;
    }
    .search-bar button {
      border: 1px solid #9db8de;
      background: #eef4ff;
      color: #20446b;
      border-radius: 10px;
      padding: 10px 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .search-status {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill {
      background: rgba(255,255,255,0.14);
      border: 1px solid rgba(255,255,255,0.24);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 18px;
      padding: 18px;
      align-items: start;
    }
    .nav {
      position: sticky;
      top: 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 8px 24px rgba(32, 66, 115, 0.08);
    }
    .nav h2 {
      font-size: 14px;
      margin: 0 0 10px;
      color: #25486f;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .nav a {
      display: block;
      text-decoration: none;
      color: var(--ink);
      padding: 7px 9px;
      border-radius: 8px;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .nav a:hover,
    .nav a.active {
      background: #e8f0ff;
      color: #173f7d;
    }
    .main {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px 20px;
      box-shadow: 0 8px 24px rgba(32, 66, 115, 0.08);
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 22px;
      color: #173a63;
    }
    .card h3 {
      margin: 18px 0 8px;
      font-size: 16px;
      color: #204a7b;
    }
    .lead {
      color: var(--muted);
      margin-top: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .mini {
      background: #f8fbff;
      border: 1px solid #dce7f6;
      border-radius: 10px;
      padding: 12px;
    }
    .mini strong {
      display: block;
      margin-bottom: 5px;
      color: #17395f;
    }
    ul, ol { padding-left: 20px; }
    li + li { margin-top: 4px; }
    .callout {
      border-left: 4px solid var(--brand);
      background: #f4f8ff;
      padding: 12px 14px;
      border-radius: 8px;
      margin: 12px 0;
    }
    .good { border-left-color: var(--ok); background: #edf9f1; }
    .warn { border-left-color: var(--warn); background: #fff7e8; }
    .bad { border-left-color: var(--bad); background: #fff0ef; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 13px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #edf4ff;
      color: #1d4169;
    }
    code {
      background: #eff5ff;
      padding: 1px 5px;
      border-radius: 5px;
      color: #274471;
      font-family: Consolas, monospace;
    }
    mark.guide-hit {
      background: #fff3a3;
      color: #4a3900;
      padding: 1px 2px;
      border-radius: 3px;
    }
    mark.guide-hit.current {
      background: #ffd54f;
      outline: 1px solid #c58f00;
    }
    .footer {
      color: var(--muted);
      text-align: center;
      padding: 8px 0 30px;
      font-size: 12px;
    }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      .nav { position: static; }
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Ascend APS User Guide</h1>
    <p>This guide covers the full scheduling workflow, factory setup, material planning, master jobs, Gantt editing, publishing back to Syspro, and troubleshooting. Use it as the main operating manual for planners, supervisors, and schedulers.</p>
    <div class="hero-meta">
      <span class="pill">Comprehensive guide</span>
      <span class="pill">Standalone window</span>
      <span class="pill">Focus: ${section}</span>
    </div>
  </div>

  <div class="search-bar">
    <input id="guideSearchInput" type="text" placeholder="Search the guide for keywords, modules, buttons, or topics..." />
    <button id="guideSearchBtn" type="button">Search</button>
    <button id="guideNextBtn" type="button">Next</button>
    <button id="guideClearBtn" type="button">Clear</button>
    <span id="guideSearchStatus" class="search-status">Type a keyword to search</span>
  </div>

  <div class="layout">
    <nav class="nav">
      <h2>Contents</h2>
      <a href="#overview">1. Overview</a>
      <a href="#quick-start">2. Quick Start</a>
      <a href="#company">3. Open Company & Connections</a>
      <a href="#layout">4. Screen Layout</a>
      <a href="#jobs">5. Production Jobs</a>
      <a href="#master-jobs">6. Master Jobs</a>
      <a href="#schedule-board">7. Schedule Board</a>
      <a href="#scheduling">8. Generate & Rules</a>
      <a href="#schedule-around">9. Schedule Around</a>
      <a href="#drag-edit">10. Drag Editing</a>
      <a href="#materials">11. Material Planning</a>
      <a href="#workcentres">12. Work Centres & Machines</a>
      <a href="#alternatives">13. Alternative Machines</a>
      <a href="#shifts">14. Shifts & Calendars</a>
      <a href="#constraints">15. Constraints & Overrides</a>
      <a href="#analysis">16. Analysis Views</a>
      <a href="#what-if">17. What-If & History</a>
      <a href="#publish">18. Save and Publish</a>
      <a href="#imports">19. Import / Export</a>
      <a href="#shortcuts">20. Shortcuts</a>
      <a href="#troubleshooting">21. Troubleshooting</a>
      <a href="#best-practice">22. Best Practice Workflow</a>
    </nav>

    <main class="main">
      <section class="card" id="overview">
        <h2>1. Overview</h2>
        <p class="lead">Ascend APS is a production scheduling cockpit connected to Syspro. It combines live job data, operation routing, work centre resources, schedule generation, and publish-back into a single planning workspace.</p>
        <div class="grid">
          <div class="mini"><strong>Primary purpose</strong>Build and review finite schedules using real job, machine, and calendar data.</div>
          <div class="mini"><strong>Live data source</strong>Production orders and routing are read from Syspro tables and company-specific records.</div>
          <div class="mini"><strong>Planner actions</strong>Generate, reschedule, review materials, drag-edit, compare, and publish updates back.</div>
          <div class="mini"><strong>Main outcomes</strong>Better visibility of machine loading, late jobs, bottlenecks, and material readiness.</div>
        </div>
        <div class="callout good"><strong>Important:</strong> the schedule board now only shows either live Syspro schedule dates or a schedule created in the current session.</div>
      </section>

      <section class="card" id="quick-start">
        <h2>2. Quick Start</h2>
        <ol>
          <li>Open the correct company from the File area.</li>
          <li>Refresh jobs and resources.</li>
          <li>Check the planning horizon on the left side.</li>
          <li>Review Production Jobs or Master Jobs and filter the data set.</li>
          <li>Click Generate or Autoschedule.</li>
          <li>Review the Gantt, materials, constraints, KPIs, and bottlenecks.</li>
          <li>Make adjustments manually if required.</li>
          <li>Use Save and Publish to write machine and schedule dates back to Syspro.</li>
        </ol>
      </section>

      <section class="card" id="company">
        <h2>3. Open Company & Connections</h2>
        <p>Use the File ribbon to connect to the required Syspro company and scheduler database.</p>
        <h3>What you can set</h3>
        <ul>
          <li>SQL server name</li>
          <li>Instance name</li>
          <li>Port</li>
          <li>Company database</li>
          <li>Scheduler database</li>
          <li>User name and password</li>
          <li>Authentication mode</li>
        </ul>
        <div class="callout warn"><strong>Tip:</strong> if the system falls into read-only mode, scheduling and publish-back are intentionally blocked until the connection is restored.</div>
      </section>

      <section class="card" id="layout">
        <h2>4. Screen Layout</h2>
        <table>
          <thead><tr><th>Area</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr><td>Top ribbon</td><td>Main commands such as Open Company, Generate, Schedule Around, Save and Publish, and reporting.</td></tr>
            <tr><td>Factory Explorer</td><td>Work centre and machine tree with horizon settings and quick actions.</td></tr>
            <tr><td>Jobs pane</td><td>Production Jobs and Master Jobs with filters, status columns, and drill-down operations.</td></tr>
            <tr><td>Bottom analysis area</td><td>Gantt, KPIs, Capacity, Pegging, What-If, Constraints, History, Materials, and more.</td></tr>
          </tbody>
        </table>
      </section>

      <section class="card" id="jobs">
        <h2>5. Production Jobs</h2>
        <p>The Production Jobs pane lists open jobs individually and allows drill-down to operations.</p>
        <h3>Available controls</h3>
        <ul>
          <li>Search by job, item, or description</li>
          <li>Filter by status</li>
          <li>Filter by work centre</li>
          <li>Filter by schedule state: Scheduled, Partially Scheduled, or Not Scheduled</li>
          <li>Show or hide columns</li>
          <li>Expand rows to inspect detailed operations</li>
        </ul>
        <h3>Status columns</h3>
        <ul>
          <li><strong>Schedule</strong> shows whether the job is fully scheduled, partly scheduled, or not scheduled.</li>
          <li><strong>Materials</strong> shows Materials, Partial, or No Materials.</li>
        </ul>
      </section>

      <section class="card" id="master-jobs">
        <h2>6. Master Jobs</h2>
        <p>The Master Jobs pane groups parent jobs and their linked sub jobs using the master-sub relationship table.</p>
        <h3>Use Master Jobs when</h3>
        <ul>
          <li>the order is built from multiple linked child jobs</li>
          <li>you want to see the family as one planning object</li>
          <li>you need to expand from master to sub jobs and then to operations</li>
        </ul>
        <div class="callout"><strong>Planner note:</strong> the master row shows the family summary, while the expanded section shows each contributing sub job and its routing details.</div>
      </section>

      <section class="card" id="schedule-board">
        <h2>7. Schedule Board</h2>
        <p>The schedule board is the visual machine timeline. It displays operations by machine or work centre, highlights lateness, and supports manual adjustment.</p>
        <h3>Board behavior</h3>
        <ul>
          <li>operations appear on the correct lane using schedule dates</li>
          <li>highlighting a job narrows the visible route sequence</li>
          <li>current time, colors, and utilization are shown for fast review</li>
          <li>the board respects working calendars and setup-time placement rules</li>
        </ul>
      </section>

      <section class="card" id="scheduling">
        <h2>8. Generate & Rules</h2>
        <p>The scheduler generates a finite plan using machine capacity, setup times, operation sequence, queue logic, movement time, and working windows. Planners can now run the schedule forward from the first operation or backward from the last one.</p>
        <h3>Scheduling rules available</h3>
        <ul>
          <li><strong>Priority</strong> — uses the priority ranking first</li>
          <li><strong>EDD</strong> — earliest due date first</li>
          <li><strong>FIFO</strong> — first in first out</li>
          <li><strong>SPT</strong> — shortest processing time first</li>
          <li><strong>Critical Ratio</strong> — urgent jobs based on time remaining versus work remaining</li>
        </ul>
        <div class="callout good"><strong>Current rule enforcement:</strong> setup time is now only scheduled inside valid working time.</div>
        <div class="callout"><strong>Date anchor options:</strong> you can use the original Syspro dates or the currently selected horizon start or end date as the scheduling anchor. Forward mode uses the start date. Backward mode uses the end date.</div>
      </section>

      <section class="card" id="schedule-around">
        <h2>9. Schedule Around</h2>
        <p>Schedule Around lets planners reschedule relative to a selected job or family.</p>
        <ul>
          <li><strong>Left</strong> — place work before the selected anchor</li>
          <li><strong>Right</strong> — place work after the selected anchor</li>
          <li><strong>Both</strong> — balance work on both sides</li>
          <li><strong>Entire Master Job</strong> — treat the full family as the scheduling scope</li>
        </ul>
      </section>

      <section class="card" id="drag-edit">
        <h2>10. Drag Editing</h2>
        <p>The Drag Edit view and schedule board support controlled manual adjustments.</p>
        <h3>Typical uses</h3>
        <ul>
          <li>move a job to a better time slot</li>
          <li>rebalance machine sequence</li>
          <li>shift work after a constraint or breakdown</li>
          <li>simulate alternative dates before publish-back</li>
        </ul>
        <div class="callout warn"><strong>Best practice:</strong> use drag editing after generation, not before, so you start from a valid finite plan.</div>
      </section>

      <section class="card" id="materials">
        <h2>11. Material Planning</h2>
        <p>The materials view summarizes requirement coverage using scheduled demand, stock on hand, and open supply.</p>
        <h3>What to review</h3>
        <ul>
          <li>job-level material readiness badges</li>
          <li>component shortages</li>
          <li>open purchase order support</li>
          <li>partial coverage versus full availability</li>
        </ul>
      </section>

      <section class="card" id="workcentres">
        <h2>12. Work Centres & Machines</h2>
        <p>The Manage area includes Work Centers and Machines so planners can inspect the live manufacturing structure.</p>
        <ul>
          <li>Work Centers displays the available data from the Syspro work centre tables</li>
          <li>Machines lets you review machine definitions and assignments</li>
          <li>Factory Explorer makes it easy to filter jobs by selected work centres</li>
        </ul>
      </section>

      <section class="card" id="alternatives">
        <h2>13. Alternative Machines</h2>
        <p>Alternative groups allow several machines to support the same work centre so jobs can flex across equivalent capacity.</p>
        <h3>How to use</h3>
        <ol>
          <li>Select a work centre</li>
          <li>Name the alternative group</li>
          <li>Choose the machines that belong to it</li>
          <li>Save the group for planning reuse</li>
        </ol>
      </section>

      <section class="card" id="shifts">
        <h2>14. Shifts & Calendars</h2>
        <p>Shift templates define when the scheduler is allowed to place work.</p>
        <ul>
          <li>set start and end times</li>
          <li>assign working days</li>
          <li>configure hours per day</li>
          <li>add diversions for planned downtime or allowed production windows</li>
        </ul>
      </section>

      <section class="card" id="constraints">
        <h2>15. Constraints & Overrides</h2>
        <p>Constraint views show scheduling conflicts, shortages, and capacity problems. Override tools allow controlled planner intervention.</p>
        <table>
          <thead><tr><th>Constraint area</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr><td>Capacity</td><td>Warns when no feasible slot can be found.</td></tr>
            <tr><td>Material</td><td>Flags shortages or incomplete component coverage.</td></tr>
            <tr><td>Schedule date</td><td>Highlights timing problems against dates and windows.</td></tr>
            <tr><td>Override</td><td>Lets planners record exceptions for controlled recalculation.</td></tr>
          </tbody>
        </table>
      </section>

      <section class="card" id="analysis">
        <h2>16. Analysis Views</h2>
        <div class="grid">
          <div class="mini"><strong>KPIs</strong>Job counts, on-time performance, tardiness, utilization, and overall metrics.</div>
          <div class="mini"><strong>Capacity</strong>Visual load by resource over the horizon.</div>
          <div class="mini"><strong>Pegging</strong>Links jobs and operations to the planned schedule path.</div>
          <div class="mini"><strong>Bottleneck</strong>Highlights overloaded resources and constraining areas.</div>
          <div class="mini"><strong>Compare</strong>Review differences between versions.</div>
          <div class="mini"><strong>Level</strong>Support load balancing and smoother machine usage.</div>
        </div>
      </section>

      <section class="card" id="what-if">
        <h2>17. What-If & History</h2>
        <p>Scenario tools let planners experiment safely before making a final decision.</p>
        <ul>
          <li>Create a what-if scenario from the current schedule</li>
          <li>adjust dates or resources</li>
          <li>compare the scenario to the live plan</li>
          <li>use version history to restore earlier results if needed</li>
        </ul>
      </section>

      <section class="card" id="publish">
        <h2>18. Save and Publish</h2>
        <p>Save and Publish sends schedule changes back to Syspro where supported by the target operation table.</p>
        <h3>What is written back</h3>
        <ul>
          <li>machine assignment if changed</li>
          <li>scheduled start date</li>
          <li>scheduled end date</li>
        </ul>
        <div class="callout good"><strong>Recommended sequence:</strong> generate, review, correct, confirm materials, then publish.</div>
      </section>

      <section class="card" id="imports">
        <h2>19. Import / Export</h2>
        <ul>
          <li>Import jobs or operations from flat files</li>
          <li>Export schedule information as CSV, PDF, or JSON</li>
          <li>Use exports for communication, review packs, or offline checks</li>
        </ul>
      </section>

      <section class="card" id="shortcuts">
        <h2>20. Keyboard Shortcuts</h2>
        <table>
          <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td>Ctrl + Enter</td><td>Generate schedule</td></tr>
            <tr><td>Ctrl + Z</td><td>Undo</td></tr>
            <tr><td>Ctrl + Shift + Z</td><td>Redo</td></tr>
            <tr><td>Ctrl + Shift + D</td><td>Toggle dark mode</td></tr>
            <tr><td>?</td><td>Open this user guide</td></tr>
          </tbody>
        </table>
      </section>

      <section class="card" id="troubleshooting">
        <h2>21. Troubleshooting</h2>
        <h3>If Generate fails</h3>
        <ul>
          <li>check the database connection banner</li>
          <li>refresh jobs and resources</li>
          <li>confirm work centres and machines returned from Syspro</li>
          <li>review whether the planning horizon is too short</li>
        </ul>
        <h3>If jobs do not show on the board</h3>
        <ul>
          <li>make sure live Syspro schedule dates exist, or generate a new session schedule</li>
          <li>check that the selected work centre filters are not excluding the jobs</li>
          <li>confirm the date horizon overlaps the operation dates</li>
        </ul>
        <h3>If material status shows partial or none</h3>
        <ul>
          <li>review component shortages</li>
          <li>check stock and open PO timing</li>
          <li>re-run planning after supply changes</li>
        </ul>
      </section>

      <section class="card" id="best-practice">
        <h2>22. Best Practice Workflow</h2>
        <ol>
          <li>Connect to the correct company and refresh live data.</li>
          <li>Set the planning horizon to the period you actually want to plan.</li>
          <li>Review Production Jobs and Master Jobs for priority and readiness.</li>
          <li>Generate the schedule using the most suitable rule.</li>
          <li>Review bottlenecks, constraints, and materials before manual edits.</li>
          <li>Use schedule around, drag edit, or alternatives only where necessary.</li>
          <li>Compare or save a what-if version for major changes.</li>
          <li>Publish to Syspro once the plan is operationally sound.</li>
        </ol>
      </section>

      <div class="footer">Ascend APS operational guide</div>
    </main>
  </div>

  <script>
    const guideMain = document.querySelector('.main');
    const searchInput = document.getElementById('guideSearchInput');
    const searchBtn = document.getElementById('guideSearchBtn');
    const nextBtn = document.getElementById('guideNextBtn');
    const clearBtn = document.getElementById('guideClearBtn');
    const searchStatus = document.getElementById('guideSearchStatus');
    const originalHtml = guideMain.innerHTML;
    let matches = [];
    let currentIndex = -1;

    const updateStatus = () => {
      if (!searchInput.value.trim()) {
        searchStatus.textContent = 'Type a keyword to search';
        return;
      }
      searchStatus.textContent = matches.length
        ? \`\${matches.length} match\${matches.length === 1 ? '' : 'es'} found\`
        : 'No matches found';
    };

    const focusMatch = (index) => {
      matches.forEach((item) => item.classList.remove('current'));
      if (!matches.length) return;
      currentIndex = ((index % matches.length) + matches.length) % matches.length;
      const match = matches[currentIndex];
      match.classList.add('current');
      match.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const runSearch = () => {
      const term = searchInput.value.trim();
      guideMain.innerHTML = originalHtml;
      matches = [];
      currentIndex = -1;

      if (!term) {
        updateStatus();
        return;
      }

      // escapeRegExp: the closing bracket and backslash must stay escaped in
      // the EMITTED script, so they are double-escaped in this template.
      const escaped = term.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const regex = new RegExp(\`(\${escaped})\`, 'gi');
      guideMain.innerHTML = guideMain.innerHTML.replace(regex, '<mark class="guide-hit">$1</mark>');
      matches = Array.from(document.querySelectorAll('.guide-hit'));
      updateStatus();
      if (matches.length) {
        focusMatch(0);
      }
    };

    searchBtn.addEventListener('click', runSearch);
    nextBtn.addEventListener('click', () => focusMatch(currentIndex + 1));
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      guideMain.innerHTML = originalHtml;
      matches = [];
      currentIndex = -1;
      updateStatus();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        runSearch();
      }
    });

    const target = document.getElementById(${JSON.stringify(focus)});
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  </script>
</body>
</html>`;
};
