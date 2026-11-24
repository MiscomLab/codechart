const express = require('express');
const { listUsers, createUser } = require('./users');

const app = express();
const router = express.Router();

app.use(express.json());

app.get('/users', listUsers);
app.post("/users", createUser);

router.delete('/users/:id', (req, res) => {
  res.status(204).end();
});

function mountAdmin(server) {
  server.get('/admin', (req, res) => res.send('ok'));
}

app.use('/api', router);
app.listen(3000);
