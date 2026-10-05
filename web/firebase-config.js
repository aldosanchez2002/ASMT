// Firebase web config. These values are NOT secrets — every Firebase web app
// ships them to the browser. Access is controlled by the Firestore security
// rules set in the Firebase console.
//
// From: Firebase console → Project settings → Your apps → Web app.
export const firebaseConfig = {
  apiKey: 'AIzaSyA6kYZAWWmGRdVJdu4sAvNzkKidK-OX5Jg',
  authDomain: 'aslogdev-a7225.firebaseapp.com',
  projectId: 'aslogdev-a7225',
  appId: '1:917626100646:web:c3718a76005f689ed48d67',
};

// false = anyone with the link can view the fleet (prototype mode).
// true  = Google sign-in required; also restrict reads in the Firestore
//         rules and set the ALLOWED_EMAILS secret.
export const requireSignIn = false;
