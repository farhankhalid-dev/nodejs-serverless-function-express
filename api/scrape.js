const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// Initialize CORS middleware
const corsMiddleware = cors({
  methods: ['POST', 'GET', 'HEAD'],
});

async function scrapeData(username, password) {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  }));

  try {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const loginPageResponse = await client.get('https://iulms.edu.pk/login/index.php');
    const $ = cheerio.load(loginPageResponse.data);
    
    const formData = new URLSearchParams();
    $('#login input').each((i, el) => {
      const input = $(el);
      const name = input.attr('name');
      const value = input.attr('value') || '';
      if (name) formData.append(name, value);
    });

    formData.set('username', username);
    formData.set('password', password);
    formData.set('testcookies', '1');

    const loginResponse = await client.post(
      'https://iulms.edu.pk/login/index.php',
      formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://iulms.edu.pk',
          'Referer': 'https://iulms.edu.pk/login/index.php'
        }
      }
    );

    if (loginResponse.data.includes('Invalid login')) {
      throw new Error('Invalid credentials');
    }

    const registrationResponse = await client.get(
      'https://iulms.edu.pk/registration/Registration_FEST_student_EarlyRegistrationBeta.php'
    );

    const $reg = cheerio.load(registrationResponse.data);

    const formattedData = (() => {
      const studentInfo = {};
      const infoTable = $reg('#gpaInfo');
      if (infoTable.length) {
        infoTable.find('tr').each((i, row) => {
          const cells = $reg(row).find('td');
          if (cells.length >= 2) {
            const key = $reg(cells[0]).text().replace(':', '').trim();
            
            if (["Name", "Reg. Number", "Program", "Credit Hours Completed", 
                "Credit Hours Required", "Credit Hours Remaining"].includes(key)) {
              studentInfo[key] = $reg(cells[1]).text().trim();
            }

            if (cells.length === 4 && $reg(cells[2]).text().includes("Credit Hours")) {
              const additionalKey = $reg(cells[2]).text().replace(':', '').trim();
              studentInfo[additionalKey] = $reg(cells[3]).text().trim();
            }
          }
        });
      }

      const normalizeSemester = (semesterString) => {
        const semesterRegex = /^Semester/i;
        const cleanString = semesterString.split('Code')[0].trim();
        return semesterRegex.test(cleanString)
          ? cleanString
          : "Depth Elective";
      };

      const selectedCourseIds = [];
      $reg('input[type="checkbox"]:checked').each((i, checkbox) => {
        selectedCourseIds.push($reg(checkbox).attr('id'));
      });

      const extractSemesterData = (table, semesterName) => {
        const rows = $reg(table).find('tr').slice(1);
        return rows.map((i, row) => {
          const columns = $reg(row).find('td');
          if (columns.length === 0) return null;

          const statusCell = columns.eq(0);
          let status = "unknown";
          if (statusCell.find('img[src*="tick.png"]').length) status = "cleared";
          if (statusCell.find('img[src*="lock2.png"]').length) status = "locked";
          if (statusCell.find('img[src*="cross.png"]').length) status = "not offered";
          if (statusCell.find('input[type="checkbox"]').length) status = "available";

          const checkbox = statusCell.find('input[type="checkbox"]');
          const inputId = checkbox.length ? checkbox.attr('id') : null;

          const timingCell = columns.eq(7).text().trim();
          const timings = timingCell
            .split(",")
            .map((slot) => {
              const parts = slot.trim().split(" ");
              let [day, startTime, endTime, room] = ["", "", "", ""];

              if (parts.length >= 4) {
                [day, startTime, endTime, room] = parts;
              } else if (parts.length === 3) {
                [day, startTime, endTime] = parts;
              }

              return { day, startTime, endTime, room };
            })
            .filter(timing => timing.day || timing.startTime || timing.endTime || timing.room);

          return {
            semester: semesterName,
            status,
            inputId,
            courseCode: columns.eq(1).text().trim() || "",
            preRequisite: columns.eq(2).text().trim() || "",
            credits: parseFloat(columns.eq(3).text().trim()) || 0,
            courseName: columns.eq(4).text().trim() || "",
            grade: columns.eq(5).text().trim() || "",
            facultyName: columns.eq(6).text().trim() || "",
            timings,
          };
        }).get().filter(Boolean);
      };

      const courses = [];
      $reg('table.tableStyle').each((i, table) => {
        const headerElement = $reg(table).find('tr.tableHeaderStyle td');
        const headerText = headerElement.text().trim();
        const semesterName = normalizeSemester(headerText);

        const innerTable = $reg(table).find('table');
        if (innerTable.length) {
          const semesterCourses = extractSemesterData(innerTable, semesterName)
            .filter(course => course && course.courseCode);
          courses.push(...semesterCourses);
        }
      });

      const groupedCourses = courses.reduce((acc, course) => {
        if (!acc[course.courseCode]) {
          acc[course.courseCode] = [];
        }
        acc[course.courseCode].push(course);
        return acc;
      }, {});

      const courseGroups = Object.entries(groupedCourses).map(([courseCode, courses]) => {
        const mainCourse = courses[0];
        const slots = courses.map(course => ({
          inputId: course.inputId,
          timings: course.timings,
          facultyName: course.facultyName,
          status: course.status,
        }));

        let status = mainCourse.status;
        if (status === "unknown") {
          if (mainCourse.facultyName === "In Progress") {
            status = "In Progress";
          } else if (mainCourse.facultyName === "Pre Requisite not cleared") {
            status = "Pre Requisites not cleared";
          }
        }

        return {
          Name: mainCourse.courseName,
          CourseCode: courseCode,
          Status: status,
          PreRequisites: !mainCourse.preRequisite || mainCourse.preRequisite === "-" 
            ? ["None"] 
            : mainCourse.preRequisite.split("\n"),
          Credits: mainCourse.credits,
          SLOTS: slots,
          Grade: mainCourse.grade === "To be taken" ? "N/A" : mainCourse.grade,
          Semester: mainCourse.semester,
        };
      });

      const semesterGroups = courseGroups.reduce((acc, course) => {
        const { Semester, ...courseWithoutSemester } = course;
        if (!acc[Semester]) {
          acc[Semester] = [];
        }
        acc[Semester].push(courseWithoutSemester);
        return acc;
      }, {});

      const sortedSemesters = Object.entries(semesterGroups)
        .map(([semester, courses]) => ({
          semester,
          courses,
        }))
        .sort((a, b) => {
          if (a.semester.toLowerCase().includes("depth elective")) return 1;
          if (b.semester.toLowerCase().includes("depth elective")) return -1;

          const getSemesterNumber = sem => {
            const match = sem.match(/\d+/);
            return match ? parseInt(match[0]) : Infinity;
          };

          const aNum = getSemesterNumber(a.semester);
          const bNum = getSemesterNumber(b.semester);

          return isFinite(aNum) && isFinite(bNum)
            ? aNum - bNum
            : a.semester.localeCompare(b.semester);
        });

      return {
        studentInfo,
        selectedCourseIds,
        semesters: sortedSemesters,
      };
    })();

    return formattedData;

  } catch (error) {
    console.error('Error during scraping:', error);
    throw error;
  }
}

const handler = async (req, res) => {
  console.log('Request received:', req.method);

  try {
    // Run the CORS middleware
    await new Promise((resolve, reject) => {
      corsMiddleware(req, res, (result) => {
        if (result instanceof Error) {
          return reject(result);
        }
        return resolve(result);
      });
    });

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password required'
      });
    }

    const data = await scrapeData(username, password);
    return res.status(200).json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Error:', error);
    const statusCode = error.message.includes('Invalid credentials') ? 401 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: true,
  },
};
