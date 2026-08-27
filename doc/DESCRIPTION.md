Personal file storage for your YunoHost server, with a web interface and a
native iOS client.

Every file belongs to exactly one account and lives in that account's own area.
Sharing publishes an item to everyone who has access to the app without moving
it: it stays in the owner's files, keeps counting against their quota, and stops
being visible to anyone else the moment they unshare it.

The web interface has list and icon views, thumbnails for images, videos and
PDFs, drag-and-drop upload, multi-select with move, copy, share and delete,
full-screen previews, recursive search, and a Recently Deleted folder items stay
in for 30 days.

Large uploads are sent in pieces, so an interrupted transfer resumes instead of
starting over — which matters on a phone that keeps changing network.

There are two ways to sign in. Browsers can go through the YunoHost portal as
usual, or register a passkey and sign in with the fingerprint, face or PIN on
their own device — no password crosses the network, and nothing reusable is
stored on the server. Native clients authenticate against LDAP and receive a
token that stops working when you revoke their access to the app.
