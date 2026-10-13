// Supabase project shared by the form (index.html) and the staff dashboard
// (admin/). Both values are on the project's Settings -> API Keys page. The
// publishable key is meant to be public: the database rules in supabase/ decide
// what it can do. Leave SUPABASE_URL empty to run the form in preview mode.
const SUPABASE_URL = "https://acsmfampogsmtakoglke.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_bQv8l_Yrd3JRYq8RhBlhNw_U2vsevJl";
const SUBMISSIONS_TABLE = "student_interest_submissions";
const CV_BUCKET = "cvs";

// Universities offered on the form, saved by their short name. Students can
// also pick "Other" and type theirs. Add or remove entries here; both the form
// and the dashboard read this list.
const UNIVERSITIES = [
  ["AUB", "American University of Beirut"],
  ["AUCE", "American University of Culture and Education"],
  ["AUL", "Arts, Sciences and Technology University in Lebanon"],
  ["AUST", "American University of Science and Technology"],
  ["AUT", "American University of Technology"],
  ["AOU", "Arab Open University"],
  ["BAU", "Beirut Arab University"],
  ["GU", "Global University"],
  ["HU", "Haigazian University"],
  ["IUL", "Islamic University of Lebanon"],
  ["LAU", "Lebanese American University"],
  ["LIU", "Lebanese International University"],
  ["LU", "Lebanese University"],
  ["MUBS", "Modern University for Business and Science"],
  ["NDU", "Notre Dame University–Louaize"],
  ["RHU", "Rafik Hariri University"],
  ["UA", "Antonine University"],
  ["UOB", "University of Balamand"],
  ["USAL", "University of Sciences and Arts in Lebanon"],
  ["USEK", "Holy Spirit University of Kaslik"],
  ["USJ", "Saint Joseph University of Beirut"],
];
