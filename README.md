# AniSkolar

## Project Title
**AniSkolar – Scholarship Management Portal**

---

## Description

AniSkolar is a web-based Scholarship Management Portal developed for De La Salle University–Dasmariñas (DLSU-D). The system streamlines the scholarship application process by allowing students to create accounts, manage their profiles, apply for scholarships, and monitor their application status. It also provides a foundation for administrators to manage scholarship applications efficiently.

The project consists of two separate applications:

- **AniSkolar_Frontend** – Built with React, TypeScript, Vite, and Tailwind CSS.
- **AniSkolar_Backend** – Built with Node.js, Express.js, and MongoDB.

Both applications must be running simultaneously for the system to function correctly.

---

## System Requirements

Before running the project, make sure the following are installed:

### Software Requirements
- Node.js (LTS Version Recommended)
- npm (comes with Node.js)
- Git
- MongoDB Atlas account (or a local MongoDB server)
- Visual Studio Code (recommended)

### Technologies Used
**Frontend**
- React
- TypeScript
- Vite
- Tailwind CSS
- Framer Motion
- Lucide React

**Backend**
- Node.js
- Express.js
- MongoDB
- Mongoose
- JSON Web Token (JWT)

---

# Installation Steps

## 1. Clone the Repository

```bash
git clone <repository-url>
```

Navigate to the project folder:

```bash
cd AniSkolar
```

Project Structure:

```
AniSkolar/
│
├── AniSkolar_Frontend/
└── AniSkolar_Backend/
```

---

## 2. Install Backend Dependencies

```bash
cd AniSkolar_Backend
npm install
```

Create a `.env` file inside the backend folder.

Example:

```env
MONGODB_URI=your_mongodb_connection_string
PORT=5000
JWT_SECRET=your_secret_key
```

---

## 3. Install Frontend Dependencies

Open another terminal.

```bash
cd AniSkolar_Frontend
npm install
```

Create a `.env` file if necessary.

Example:

```env
VITE_API_URL=http://localhost:5000
```

---

# How to Run the Program

Since the frontend and backend are separate applications, they must be started in different terminals.

## Terminal 1 – Backend

```bash
cd AniSkolar_Backend
node server.js
```

The backend server will run on:

```
http://localhost:5000
```

---

## Terminal 2 – Frontend

```bash
cd AniSkolar_Frontend
npm run dev
```

The frontend development server will usually run on:

```
http://localhost:3000
```

---

Once both servers are running, open your browser and visit:

```
http://localhost:3000
```

The frontend will communicate with the backend through the configured API.

---

## Project Structure

```
AniSkolar/
│
├── AniSkolar_Frontend/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── ...
│
├── AniSkolar_Backend/
│   ├── routes/
│   ├── models/
│   ├── middleware/
│   ├── server.js
│   └── ...
│
└── README.md
```

---

## Current Features

- Student Registration
- Student Login
- JWT Authentication
- Student Profile Management
- Scholarship Application
- GPA Calculator
- Responsive User Interface
- MongoDB Database Integration

---

## Known Limitations

- Microsoft Sign-In is currently under development and is not yet functional.
- The application requires both the frontend and backend servers to be running simultaneously.

---

## Team Members

|         Name             |          Role            |
|--------------------------|--------------------------|
| **Paula Mitchel Ng**     | Documentation / Frontend |
| **Aiven Allyson Martin** |   Frontend / Backend     |
| **Patrick James Lauron** |   Frontend / Backend     |

---

## License

This project was developed for academic purposes at **De La Salle University–Dasmariñas (DLSU-D)**.