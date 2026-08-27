Personal file storage for your YunoHost server, with a web interface and a
native iOS client.

Each account gets a private area; everyone with access to the app shares a
common one. The web interface has list and icon views, thumbnails for images,
videos and PDFs, drag-and-drop upload, recursive search, and a Recently Deleted
folder items stay in for 30 days.

Large uploads are sent in pieces, so an interrupted transfer resumes instead of
starting over — which matters on a phone that keeps changing network.

Browsers sign in through the YunoHost portal. Native clients authenticate with
their YunoHost user name and password against LDAP, and receive a token that
stops working when you revoke their access to the app.
