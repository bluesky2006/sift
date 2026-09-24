'use strict';
const $ = (id) => document.getElementById(id);
let setup = false;

fetch('/api/auth/status').then((r) => r.json()).then((s) => {
  setup = !s.configured;
  if (setup) {
    $('sub').textContent = 'Choose a password (12 characters or more)';
    $('password').setAttribute('autocomplete', 'new-password');
    $('go').textContent = 'Set password';
  }
});

async function submit() {
  if ($('go').disabled) return;          // Enter again while the first is still being checked
  const err = $('error');
  err.hidden = true;
  $('go').disabled = true;
  try {
    const r = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    if (r.ok) { location.href = '/app'; return; }
    const body = await r.json().catch(() => ({}));
    err.textContent = body.error || 'Sign-in failed';
    err.hidden = false;
  } finally {
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', submit);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
