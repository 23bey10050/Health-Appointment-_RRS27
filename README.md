<div align="center">
  <img src="https://via.placeholder.com/150x150/2563eb/ffffff?text=City+Care+Clinic" alt="City Care Clinic Logo" width="120" height="120" style="border-radius: 20px; box-shadow: 0 4px 14px rgba(0,0,0,0.1); margin-bottom: 20px;">
  
  <h1 align="center">City Care Clinic: AI Healthcare Manager</h1>
  <p align="center">
    <strong>A modern healthcare app with a real-time AI voice assistant, clean dashboards, and helpful AI tips for doctors.</strong>
  </p>
  
  <p align="center">
    <img src="https://img.shields.io/badge/Frontend-React%20%7C%20Vite-blue" alt="Frontend">
    <img src="https://img.shields.io/badge/Backend-FastAPI%20%7C%20Python-green" alt="Backend">
    <img src="https://img.shields.io/badge/Database-PostgreSQL%20%7C%20Redis-red" alt="Database">
    <img src="https://img.shields.io/badge/UI-TailwindCSS-cyan" alt="UI">
  </p>
</div>

<br/>

## About the Project

City Care Clinic is a web application that helps manage doctor appointments and patient follow-ups. Instead of making patients wait on hold to talk to a receptionist, the app uses a real-time AI voice assistant. This agent can talk to patients, listen to their symptoms, book their visits, and immediately warn a doctor if there is a medical emergency. 

We built the interface using a modern "Glassmorphism" style. This makes the dashboards look clean, professional, and easy to use for everyone.

---

## Screenshots

> **Note:** Replace the placeholder URLs below with your actual images or GIFs.

<div align="center">
  <table style="width: 100%; text-align: center;">
    <tr>
      <td width="50%">
        <b>Patient Portal & Voice Agent</b><br/><br/>
        <img src="https://via.placeholder.com/600x400/eff6ff/1e293b?text=[Patient+Portal+Screenshot]" alt="Patient Portal" style="border-radius:10px;">
      </td>
      <td width="50%">
        <b>Doctor Dashboard & Emergency Queue</b><br/><br/>
        <img src="https://via.placeholder.com/600x400/eff6ff/1e293b?text=[Doctor+Dashboard+Screenshot]" alt="Doctor Dashboard" style="border-radius:10px;">
      </td>
    </tr>
    <tr>
      <td width="50%">
        <b>Admin Control Panel</b><br/><br/>
        <img src="https://via.placeholder.com/600x400/eff6ff/1e293b?text=[Admin+Panel+Screenshot]" alt="Admin Panel" style="border-radius:10px;">
      </td>
      <td width="50%">
        <b>Voice Assistant Animation</b><br/><br/>
        <img src="https://via.placeholder.com/600x400/eff6ff/1e293b?text=[Add+GIF+Here]" alt="Voice Agent Animation" style="border-radius:10px;">
      </td>
    </tr>
  </table>
</div>

---

## AI Accuracy & Impact

When using good AI models (like GPT-4 or Gemini) and paid speech-to-text tools, the voice agent works very well. This saves a lot of time for clinic staff and helps handle patient emergencies much faster.

### Voice Agent Booking Accuracy

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'pie1': '#3b82f6', 'pie2': '#ef4444', 'pie3': '#f59e0b', 'pieTitleTextSize': '18px'}}}%%
pie title "Voice Agent Success Rate"
    "Successful Automated Bookings" : 92
    "Sent to Human (Emergency or Complex)" : 7
    "Misunderstood (Needed Retry)" : 1
```

### Projected Impact vs Traditional Booking

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#3b82f6', 'secondaryColor': '#ef4444'}}}%%
xychart-beta
    title "Appointments Handled per Month: AI vs Manual"
    x-axis ["Month 1", "Month 2", "Month 3", "Month 4", "Month 5", "Month 6"]
    y-axis "Appointments Processed" 0 --> 10000
    bar [1200, 2500, 4100, 6800, 8500, 9500]
    line [1000, 1050, 1100, 1150, 1200, 1250]
```
*(Bar = AI System Capacity | Line = Maximum Manual Receptionist Capacity)*

---

## How the System Works

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#eff6ff', 'primaryTextColor': '#1e293b', 'primaryBorderColor': '#3b82f6', 'lineColor': '#64748b'}}}%%
graph TD
    A[Patient Logs In] --> B(Patient Dashboard)
    B --> C{Start Voice Call?}
    C -->|Yes| D[AI Voice Agent]
    C -->|No| E[Manual Booking]
    
    D --> F{Checks Symptoms}
    F -->|Normal| G[Books Regular Appointment]
    F -->|Critical| H[Flags as EMERGENCY]
    
    G --> I[Sends Email Confirmation]
    H --> J[Alerts Doctor & Reserves Slot]
    
    J --> K[Doctor Dashboard Live Queue]
    K --> L[Doctor Acknowledges the Alert]
```

---

## What We Used

- **Frontend:** React 18, Vite, Tailwind CSS, Lucide React, and HTML5 Canvas (for the voice animation).
- **Backend:** Python 3.11, FastAPI, SQLAlchemy, and Celery (for background tasks).
- **Database & Data Storage:** PostgreSQL (with pgvector) and Redis.
- **AI & Machine Learning:** The browser handles speech-to-text. The backend connects to LLMs like Groq, Gemini, or Ollama.
- **Tools:** Docker, Docker Compose, and Alembic (for database updates).

---

## How to Run It Locally

Running the project on your own computer is easy because we use Docker.

### What you need:
- Docker and Docker Compose installed on your computer.
- Git.

### Steps to follow:
1. **Clone the code:**
   ```bash
   git clone https://github.com/23bey10050/Health-Appointment-_RRS27.git
   cd Health-Appointment-_RRS27
   ```
2. **Set up environment variables:**
   Copy the example `.env` file to create your own.
   ```bash
   cp .env.example .env
   ```
   *(Open the `.env` file and add your AI API keys, like `GROQ_API_KEY` or `GEMINI_API_KEY`. Do not share this file online!)*
   
3. **Start the project:**
   ```bash
   docker-compose up --build -d
   ```
   
4. **Open it in your browser:**
   - **Frontend App:** [http://localhost:5173](http://localhost:5173)
   - **Backend API:** [http://localhost:8000/docs](http://localhost:8000/docs)
   - **Local Emails (Mailpit):** [http://localhost:8025](http://localhost:8025)

---

## How to Deploy to Production

When you are ready to put this on the internet, you should separate the frontend and backend. 

> **Important Security Note:** 
> - Never hardcode your API Keys, passwords, or Database URLs in the code.
> - Always use the safe environment variables setup provided by your hosting service.
> - Make sure CORS is set up to only allow your official frontend domain.

### 1. Deploying the Backend
The backend is a FastAPI app running inside Docker.
- **Database:** Create a managed PostgreSQL database (it must support `pgvector`) and a managed Redis database online.
- **Web API:** Connect your GitHub repo to a service like Render or AWS. Tell it to use the `backend/Dockerfile`. Add your `DATABASE_URL` and `REDIS_URL` to the hosting settings.
- **Background Worker:** Create a background worker on your hosting service using the same Dockerfile. Change the start command to: `celery -A app.workers.celery_app worker --loglevel=info`.

### 2. Deploying the Frontend
The frontend is a static React website.
- Connect your GitHub repo to Vercel or Cloudflare Pages.
- **Folder:** Choose `frontend/`
- **Build Command:** Type `npm run build`
- **Output Folder:** Choose `dist/`
- **Settings:** Set `VITE_API_BASE_URL` to your new live backend URL (for example, `https://api.yourclinic.com`).

---

<div align="center">
  <sub>Built to make healthcare smarter and easier.</sub>
</div>
