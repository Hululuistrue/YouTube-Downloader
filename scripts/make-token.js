const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../src/config");

const email = process.argv[2] || "demo@example.com";
const userId = process.argv[3] || crypto.randomUUID();

const token = jwt.sign(
  {
    sub: userId,
    email,
  },
  config.jwtSecret,
  {
    expiresIn: "30d",
  }
);

console.log(token);
