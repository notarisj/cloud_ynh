const { Client } = require('ldapts');
async function test() {
  const client = new Client({ url: 'ldap://127.0.0.1:389' });
  try {
    const { searchEntries } = await client.search('ou=users,dc=yunohost,dc=org', { filter: '(objectClass=posixAccount)' });
    console.log('Users:', searchEntries.map(e => e.uid));
  } catch (e) {
    console.error(e);
  } finally {
    await client.unbind();
  }
}
test();
