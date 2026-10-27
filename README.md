# Toy Doctor Dispatch

A dispatch board on top of Tekmetric for the Denver and Littleton shops.

**Writes to Tekmetric (only these):** when you assign a tech, the board sets that tech on the RO, and on any of its jobs with no tech. For a booked appointment that happens once the customer arrives and the RO opens. For an open RO it happens right away. It only fills blanks, so a tech someone already set in Tekmetric is never changed.

**What's in step 1**
- **Views:** Day – Technician, Day – Service Advisor, Week, Month (the last one used is remembered)
- **Day – Service Advisor:** "Manage advisors" picks who gets a column and their order, per location (ROs by anyone else go in "Other writers").
- **Day – Service Advisor (details):** one column per advisor with today's customers at their drop-off / waiter time (one card per RO or appointment), and each advisor's ROs waiting on authorization (Pending Authorization / Estimating), oldest first. Pick an advisor on a booked appointment (click or drag); it's written to the RO's service writer when the RO opens, only if it has none. An open RO with no service writer gets it right away.
- **Week:** each day's appointments by time with type color, tech and hours, and booked hours vs. tech capacity (Near full / Over). Drag a not-arrived appointment to another day to move it in Tekmetric; "+ Book" on any day.
- **Month:** calendar with appointments and booked hours vs. capacity per day; click a day to open it.
- Booking also picks the service advisor (defaults to whoever is signed in, if they're a Tekmetric employee)
- Day – Technician board: one column per tech, 8:00–5:00 timeline, red line for now
- Live RO cards with the Tekmetric label, colored by the appointment's color
- Load per tech (sold hours vs. daily capacity), parts hold and offsite hours shown separately
- Pay-period hours completed and pace (1st–15th, 16th–end)
- Week strip with appointment and waiter counts, day summary, no-show alerts
- Google sign-in limited to @toydoctorinc.com
- **Assigning:** click any booked appointment or open RO (drag it to another tech to move it; an open RO is changed in Tekmetric right away, with Undo) to pick a tech and estimated hours, or drag it onto a tech's column

**Step 2 (availability)**
- Each tech's header has an availability button: In (default), Out, Leaves early, Limit work, a note, and daily capacity (every day or today only)
- Out / Leaves early / Limit work add a matching Tekmetric event ("OFF – Sam K.", "LEAVES 3:00 – Sam K.", "LIMIT 4h – Sam K."); setting In removes it. The board only changes events it created.
- **Booking:** "+ Book appointment" (or click an open time in a tech's column) searches Tekmetric customers by name or phone, picks the vehicle, type of work (sets the color), concern, time, drop-off, estimated hours, tech and ride. The appointment is created in Tekmetric. Waiters are booked green (the API can't set "Stay with vehicle"). New customers are added in Tekmetric first.
- **Rescheduling:** open an appointment card to change its date, time or drop-off, or drag it onto another day in the week strip. This moves the appointment in Tekmetric (drop-off moves with it). Undo is offered.
- **No-shows:** 1 hour past an appointment with no arrival, a banner offers Mark no-show (sets NO_SHOW in Tekmetric and drops its hours), Reschedule, or Still coming (keeps it, stops asking today). Cancel appointment is in the card.
- **Colors on reschedule:** Tekmetric reads colors back as hex but writes them by name. The first time an appointment is changed, the board runs a one-time color check (a short event a year out at 6:00 am, recolored through each color and deleted) and remembers the result, so moved appointments keep their color.
- "On today" hides techs who are out; "Manage techs" picks who shows on the board and their usual capacity

**Coming next:** the booking panel (new appointments from the board) and dismissing no-shows (step 3), then the Day – Service Advisor view.

---

## Try it on your computer (demo data, no credentials)

1. Install Node.js LTS from nodejs.org (once).
2. Open Terminal in this folder (`cd ` then drag the folder in, then Enter).
3. Run `npm install` (once).
4. Run `npm run demo`.
5. Open http://localhost:8080 in your browser.

## Run it against your Tekmetric sandbox

1. Copy `.env.example` to `.env` and fill in `TEKMETRIC_CLIENT_ID`, `TEKMETRIC_CLIENT_SECRET`, and `TEKMETRIC_ENV=sandbox`.
2. For a quick look without setting up Google sign-in, set `AUTH_DISABLED=true` (your computer only).
3. Run `npm start` and open http://localhost:8080.

## Shop settings

All shop rules live in `server/config.js`:
- **Shop hours, workdays, default capacity (8.0 h)**
- **Shop names:** map your Tekmetric shop IDs to "Denver" and "Littleton"
- **Label rules:** which Tekmetric label names count as active, parts hold, offsite, or done. Match these to your exact label names.

## Put it online (Google Cloud Run)

Done once, with Rachel's Workspace admin account.

1. **Google Cloud project:** at console.cloud.google.com create a project (e.g. `toy-doctor-dispatch`) and turn on billing.
2. **Google sign-in client:** APIs & Services → OAuth consent screen → *Internal*. Then Credentials → Create credentials → OAuth client ID → *Web application*. Add the app's URL under *Authorized JavaScript origins* (you get the URL in step 5; add `http://localhost:8080` too for testing). Copy the client ID.
3. **Secrets:** Security → Secret Manager. Add `TEKMETRIC_CLIENT_SECRET` and `SESSION_SECRET`.
4. **Firestore (stores assignments):** Firestore → Create database → *Native mode*, region `us-central1`. Cloud Run's default service account can use it in the same project.
5. **Deploy:** in Cloud Shell, upload this folder and run:
   ```
   gcloud run deploy toy-doctor-dispatch --source . --region us-central1 --allow-unauthenticated \
     --set-env-vars STORE=firestore,TEKMETRIC_ENV=production,TEKMETRIC_CLIENT_ID=<id>,GOOGLE_CLIENT_ID=<client id>,ALLOWED_DOMAIN=toydoctorinc.com \
     --set-secrets TEKMETRIC_CLIENT_SECRET=TEKMETRIC_CLIENT_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest
   ```
   `--allow-unauthenticated` only lets the page load; the app itself requires Google sign-in with a toydoctorinc.com account.
6. Add the Cloud Run URL to the OAuth client's JavaScript origins (step 2), then open it.

## How it's built

- `server/index.js`: web server and API (`/api/shops`, `/api/board`)
- `server/board.js`: the board rules (load, parked, pay period, pace, colors)
- `server/tekmetric.js`: Tekmetric API client (token, paging, 60-second cache, rate-limit backoff)
- `server/mock.js`: demo data in Tekmetric's real response shapes
- `server/auth.js`: Google sign-in and signed session cookie
- `server/store.js`: assignments (JSON file locally, Firestore on Cloud Run)
- `server/views.js`: Week and Month planners
- `server/appointments.js`: booking, rescheduling, no-show and cancel in Tekmetric; customer and vehicle search; the color check
- `server/sync.js`: writes the assigned tech onto the RO (fills blanks only, once per RO)
- `public/`: the board page (plain HTML, CSS, JavaScript; no build step)
