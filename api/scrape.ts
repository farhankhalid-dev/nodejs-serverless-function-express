import { VercelRequest, VercelResponse } from '@vercel/node';
import cors from 'cors';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import * as cheerio from 'cheerio';

// Initialize CORS middleware
const corsMiddleware = cors({
  methods: ['POST', 'GET', 'HEAD'],
});

// Define interfaces
interface RequestBody {
  username: string;
  password: string;
}

interface Timing {
  day: string;
  startTime: string;
  endTime: string;
  room: string;
}

interface Course {
  semester: string;
  status: string;
  inputId: string | null;
  courseCode: string;
  preRequisite: string;
  credits: number;
  courseName: string;
  grade: string;
  facultyName: string;
  timings: Timing[];
}

interface CourseGroup {
  Name: string;
  CourseCode: string;
  Status: string;
  PreRequisites: string[];
  Credits: number;
  SLOTS: Array<{
    inputId: string | null;
    timings: Timing[];
    facultyName: string;
    status: string;
  }>;
  Grade: string;
  Semester: string;
}

interface FormattedData {
  studentInfo: {
    [key: string]: string;
  };
  selectedCourseIds: string[];
  semesters: Array<{
    semester: string;
    courses: Omit<CourseGroup, 'Semester'>[];
  }>;
}

async function scrapeData(username: string, password: string): Promise<FormattedData> {
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
      const studentInfo: { [key: string]: string } = {};
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

      const normalizeSemester = (semesterString: string): string => {
        const semesterRegex = /^Semester/i;
        const cleanString = semesterString.split('Code')[0].trim();
        return semesterRegex.test(cleanString)
          ? cleanString
          : "Depth Elective";
      };

      const selectedCourseIds: string[] = [];
      $reg('input[type="checkbox"]:checked').each((i, checkbox) => {
        const id = $reg(checkbox).attr('id');
        if (id) selectedCourseIds.push(id);
      });

      const extractSemesterData = (table: cheerio.Cheerio, semesterName: string): Course[] => {
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
        }).get().filter((course): course is Course => course !== null);
      };

      const courses: Course[] = [];
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

      const groupedCourses = courses.reduce<{ [key: string]: Course[] }>((acc, course) => {
        if (!acc[course.courseCode]) {
          acc[course.courseCode] = [];
        }
        acc[course.courseCode].push(course);
        return acc;
      }, {});

      const courseGroups: CourseGroup[] = Object.entries(groupedCourses).map(([courseCode, courses]) => {
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

      const semesterGroups = courseGroups.reduce<{ [key: string]: Omit<CourseGroup, 'Semester'>[] }>(
        (acc, course) => {
          const { Semester, ...courseWithoutSemester } = course;
          if (!acc[Semester]) {
            acc[Semester] = [];
          }
          acc[Semester].push(courseWithoutSemester);
          return acc;
        }, 
        {}
      );

      const sortedSemesters = Object.entries(semesterGroups)
        .map(([semester, courses]) => ({
          semester,
          courses,
        }))
        .sort((a, b) => {
          if (a.semester.toLowerCase().includes("depth elective")) return 1;
          if (b.semester.toLowerCase().includes("depth elective")) return -1;

          const getSemesterNumber = (sem: string) => {
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

// Vercel serverless handler
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('Received request:', {
    method: req.method,
    headers: req.headers,
    body: req.body ? 'Present' : 'Missing'
  });

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

    // Only allow POST method
    if (req.method !== 'POST') {
      console.log('Method not allowed:', req.method);
      return res.status(405).json({ 
        success: false, 
        error: 'Method not allowed' 
      });
    }

    const { username, password } = req.body as RequestBody;
    
    if (!username || !password) {
      console.log('Missing credentials in request');
      return res.status(400).json({ 
        success: false, 
        error: "Username and password are required" 
      });
    }

    const data = await scrapeData(username, password);
    console.log('Scraping completed successfully');
    res.status(200).json({ success: true, data });

  } catch (error) {
    console.error('Error in handler:', error);
    const statusCode = error instanceof Error && error.message.includes('Invalid credentials') ? 401 : 500;
    res.status(statusCode).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error instanceof Error ? error.stack : undefined : undefined
    });
  }
}

// Configure the API route
export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};
