# 🎬 CGR Room Scraper

CGR cinemas do not provide a straightforward way to view which movies are
assigned to which rooms, as this information is only revealed during the booking
process.

This project retrieves movie showtimes and room details from CGR cinemas and
compiles them into a structured CSV file. The goal is to offer a clearer
overview of the schedule, making it easier to analyze screenings without having
to browse film by film on the official site.

---

## 🚀 Features

- Fetches all currently scheduled movies for a given CGR cinema
- Retrieves available days for each movie
- Extracts all showtimes for each day
- Identifies the **room number** from session details
- Exports everything into a clean **CSV report**

---

## 📦 Installation

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/cgr-room-scraper.git
cd cgr-room-scraper
````

Install dependencies:

```bash
npm install
```

---

## ▶️ Usage

Run the scraper:

```bash
node index.js
```

This will:

1. Fetch all movie IDs from the cinema’s reservation form
2. Query the CGR system for available days and showtimes
3. Retrieve the room number for each screening
4. Generate a CSV file with the full schedule

---

## 📊 Example Output (CSV)

```csv
cinema;salle;salle_label;film_id;film_titre;date;heure;version;audio;seance_id;ts;reservation_url
lefrancais;06;Salle 6;12345;Jurassic World: Renaissance;2025-08-24;20:10;VF;;123456/VO;1724526600;https://achat.cgrcinemas.fr/lefrancais/reserver/...
lefrancais;03;Salle 3;67890;Elio;2025-08-24;22:30;VF;;678901/VO;1724535000;https://achat.cgrcinemas.fr/lefrancais/reserver/...
lefrancais;10;Salle 10;54321;Bluey au Cinéma;2025-08-25;14:00;VF;;543210/VO;1724606400;https://achat.cgrcinemas.fr/lefrancais/reserver/...
```

---

## ⚠️ Disclaimer

This project is for **educational purposes only**.
CGR does not provide an official API for room information, and this scraper
simply automates data already visible on their public booking website.

---

## 🛠️ Tech Stack

* **Node.js** (JavaScript)
* **node-fetch** for HTTP requests
* **cheerio** for HTML parsing